use serde::{Deserialize, Serialize};

/// These preferences apply to both preview and execution. Deletions require
/// an explicit opt-in; new mappings never infer mirror semantics from backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncPreferences {
    pub ignore_patterns: Vec<String>,
    pub propagate_deletions: bool,
    pub pause_on_conflicts: bool,
    /// When a mapping is first reviewed over a folder that already holds the
    /// same files as its Telegram folder, treat same-path, same-size files as
    /// already in sync instead of reporting every one as a conflict. Contents
    /// cannot be compared without downloading, so this is opt-in.
    pub adopt_matching_files: bool,
}

impl Default for SyncPreferences {
    fn default() -> Self {
        Self {
            ignore_patterns: vec![".git/".into(), "node_modules/".into(), ".DS_Store".into()],
            propagate_deletions: false,
            pause_on_conflicts: true,
            adopt_matching_files: false,
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
