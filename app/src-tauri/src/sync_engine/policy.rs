use serde::{Deserialize, Serialize};

/// These preferences apply to both preview and execution. Deletions require
/// an explicit opt-in; new mappings never infer mirror semantics from backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncPreferences {
    pub ignore_patterns: Vec<String>,
    pub propagate_deletions: bool,
    pub pause_on_conflicts: bool,
}

impl Default for SyncPreferences {
    fn default() -> Self {
        Self {
            ignore_patterns: vec![".git/".into(), "node_modules/".into(), ".DS_Store".into()],
            propagate_deletions: false,
            pause_on_conflicts: true,
        }
    }
}

impl SyncPreferences {
    pub fn validated(mut self) -> Result<Self, String> {
        if self.ignore_patterns.len() > 128 {
            return Err("Use at most 128 ignore patterns".into());
        }
        for pattern in &mut self.ignore_patterns {
            *pattern = pattern.trim().to_string();
            if pattern.len() > 256 || pattern.chars().any(char::is_control) {
                return Err("Each ignore pattern must contain at most 256 printable bytes".into());
            }
            if pattern.starts_with('/')
                || pattern.contains('\\')
                || pattern.split('/').any(|part| part == ".." || part == ".")
            {
                return Err("Ignore patterns must be relative paths using / separators".into());
            }
        }
        self.ignore_patterns.retain(|pattern| !pattern.is_empty());
        self.ignore_patterns.sort();
        self.ignore_patterns.dedup();
        Ok(self)
    }

    pub fn ignores(&self, relative_path: &str) -> bool {
        // Reserved staging artifacts are always ignored, including when a
        // user replaces all default patterns.
        if relative_path.ends_with(".td-sync-tmp") {
            return true;
        }
        self.ignore_patterns
            .iter()
            .any(|pattern| matches_ignore_pattern(pattern, relative_path))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredPairPolicy {
    pub account_owner: Option<String>,
    pub preferences: SyncPreferences,
}

/// Small bounded wildcard matcher: `*` matches any number of characters and
/// `?` matches one Unicode character. No recursive backtracking or filesystem
/// access is needed when applying patterns to an entire scan.
fn wildcard_match(pattern: &str, value: &str) -> bool {
    let value: Vec<char> = value.chars().collect();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for character in pattern.chars() {
        let mut current = vec![false; value.len() + 1];
        if character == '*' {
            current[0] = previous[0];
            for index in 1..=value.len() {
                current[index] = previous[index] || current[index - 1];
            }
        } else {
            for index in 1..=value.len() {
                current[index] =
                    previous[index - 1] && (character == '?' || character == value[index - 1]);
            }
        }
        previous = current;
    }
    previous[value.len()]
}

fn matches_ignore_pattern(pattern: &str, relative_path: &str) -> bool {
    if let Some(directory_pattern) = pattern.strip_suffix('/') {
        for (index, character) in relative_path.char_indices() {
            if character == '/' {
                let prefix = &relative_path[..index];
                if wildcard_match(directory_pattern, prefix)
                    || (!directory_pattern.contains('/')
                        && prefix
                            .rsplit('/')
                            .next()
                            .is_some_and(|name| wildcard_match(directory_pattern, name)))
                {
                    return true;
                }
            }
        }
        return false;
    }
    wildcard_match(pattern, relative_path)
        || (!pattern.contains('/')
            && relative_path
                .rsplit('/')
                .next()
                .is_some_and(|name| wildcard_match(pattern, name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_defaults_preserve_deletions_and_pause_conflicts() {
        let preferences = SyncPreferences::default();
        assert!(!preferences.propagate_deletions);
        assert!(preferences.pause_on_conflicts);
        assert!(StoredPairPolicy::default().account_owner.is_none());
    }

    #[test]
    fn ignored_directories_do_not_hide_similarly_named_files() {
        let preferences = SyncPreferences {
            ignore_patterns: vec![
                ".git/".into(),
                "build/cache/".into(),
                "*.tmp".into(),
                "?.bak".into(),
            ],
            ..SyncPreferences::default()
        }
        .validated()
        .unwrap();
        for path in [
            "project/.git/config",
            "build/cache/data",
            "notes/draft.tmp",
            "é.bak",
            "partial.td-sync-tmp",
        ] {
            assert!(preferences.ignores(path), "{path}");
        }
        for path in [
            ".git",
            "build/cache.txt",
            "cache/data",
            "notes/draft.txt",
            "word.bak",
        ] {
            assert!(!preferences.ignores(path), "{path}");
        }
    }

    #[test]
    fn policy_rejects_ambiguous_or_unbounded_patterns() {
        for pattern in ["../private", "/absolute", "windows\\path", "line\nbreak"] {
            assert!(SyncPreferences {
                ignore_patterns: vec![pattern.into()],
                ..SyncPreferences::default()
            }
            .validated()
            .is_err());
        }
        assert!(SyncPreferences {
            ignore_patterns: vec!["a".into(); 129],
            ..SyncPreferences::default()
        }
        .validated()
        .is_err());
    }
}
