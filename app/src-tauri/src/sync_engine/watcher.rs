use super::policy::SyncPreferences;
use notify_debouncer_full::{
    new_debouncer,
    notify::{
        event::{CreateKind, ModifyKind, RemoveKind},
        EventKind, RecursiveMode,
    },
    DebounceEventResult,
};
use std::{path::PathBuf, time::Duration};

pub struct LocalWatcher;

impl LocalWatcher {
    pub fn spawn(
        paths: Vec<(PathBuf, SyncPreferences)>,
        debounce: Duration,
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
            for (path, _) in &paths {
                if let Err(error) = debouncer.watch(path, RecursiveMode::Recursive) {
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
                                    if !matches!(debounced.event.kind,
                                        EventKind::Create(CreateKind::File | CreateKind::Any | CreateKind::Folder)
                                        | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Name(_))
                                        | EventKind::Remove(RemoveKind::File | RemoveKind::Any | RemoveKind::Folder)
                                    ) { continue; }
                                    for path in debounced.event.paths {
                                        if path.to_string_lossy().ends_with(".td-sync-tmp") { continue; }
                                        if paths.iter().any(|(root, preferences)| path.strip_prefix(root).ok().is_some_and(|relative| {
                                            let relative = relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                                            preferences.ignores(&relative) || (path.is_dir() && preferences.ignores(&format!("{relative}/")))
                                        })) { continue; }
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
