use notify_debouncer_full::{
    new_debouncer,
    notify::{
        event::{CreateKind, ModifyKind, RemoveKind},
        EventKind, RecursiveMode,
    },
    DebounceEventResult,
};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFsEvent {
    pub action: String,
    pub path: String,
}

pub struct LocalWatcher;

impl LocalWatcher {
    pub fn spawn(
        paths: Vec<PathBuf>,
        debounce: Duration,
        app: tauri::AppHandle,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
        trigger: tokio::sync::mpsc::Sender<()>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
            let callback = move |result: DebounceEventResult| {
                let _ = event_tx.send(result);
            };
            let mut debouncer = match new_debouncer(debounce, None, callback) {
                Ok(debouncer) => debouncer,
                Err(error) => {
                    log::error!("Failed to create folder sync watcher: {error}");
                    return;
                }
            };
            for path in paths {
                if let Err(error) = debouncer.watch(&path, RecursiveMode::Recursive) {
                    log::error!("Failed to watch sync folder {}: {error}", path.display());
                }
            }

            loop {
                tokio::select! {
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() { break; }
                    }
                    result = event_rx.recv() => {
                        let Some(result) = result else { break };
                        match result {
                            Ok(events) => {
                                let mut should_reconcile = false;
                                for debounced in events {
                                    let action = match debounced.event.kind {
                                        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Any) => "upload",
                                        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => "hash_upload",
                                        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Any) => "delete",
                                        _ => continue,
                                    };
                                    for path in debounced.event.paths {
                                        if path.to_string_lossy().ends_with(".td-sync-tmp") { continue; }
                                        let _ = app.emit("sync-fs-event", LocalFsEvent { action: action.into(), path: path.to_string_lossy().into_owned() });
                                        should_reconcile = true;
                                    }
                                }
                                if should_reconcile {
                                    let _ = trigger.try_send(());
                                }
                            }
                            Err(errors) => for error in errors { log::warn!("Folder sync watcher error: {error}"); },
                        }
                    }
                }
            }
        })
    }
}
