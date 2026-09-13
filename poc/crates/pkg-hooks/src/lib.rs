//! libalpm hook compatibility.
//!
//! Reads `.hook` files from `/usr/share/libalpm/hooks` and `/etc/pacman.d/hooks`
//! (same precedence rules as pacman: `/etc` overrides `/usr` by file name, a
//! `.hook` in `/etc` whose `[Action]` is empty disables the one in `/usr`),
//! and says which of them a transaction would trigger — what `omarchy-cli
//! check` previews before an out-of-band install. Running them (`Exec`, in
//! `PreTransaction` / `PostTransaction` order) belongs to the parked native
//! install engine; pacman runs them itself when the thin client hands it the
//! packages.
//!
//! The format is pacman's `alpm-hooks(5)`: `[Trigger]` sections (repeatable)
//! with `Operation`, `Type` (`Package` or `Path`; `File` is the old spelling)
//! and `Target` (repeatable, shell-style globs, paths without a leading
//! slash), one `[Action]` with `Description`, `When`, `Exec`, `Depends`,
//! `AbortOnFail` and `NeedsTargets`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookWhen {
    PreTransaction,
    PostTransaction,
}

impl HookWhen {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            HookWhen::PreTransaction => "pre",
            HookWhen::PostTransaction => "post",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookOperation {
    Install,
    Upgrade,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookTarget {
    Package(String),
    Path(String),
}

/// One `[Trigger]` section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    pub operations: Vec<HookOperation>,
    pub targets: Vec<HookTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    /// The file name (`90-mkinitcpio-install.hook`), what pacman orders by.
    pub name: String,
    pub description: Option<String>,
    pub when: HookWhen,
    pub triggers: Vec<Trigger>,
    pub exec: Vec<String>,
    pub depends: Vec<String>,
    pub needs_targets: bool,
    pub abort_on_fail: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum HookError {
    #[error("{0}")]
    Format(String),
    #[error("reading {0}: {1}")]
    Io(PathBuf, std::io::Error),
}

/// What the transaction does to one package: its name, the operation, and
/// its file list when known (paths as the package lists them, with or
/// without a leading slash). Without a file list a `Path` trigger cannot
/// be decided and is reported as a possible match.
#[derive(Debug, Clone)]
pub struct TransactionPackage<'a> {
    pub name: &'a str,
    pub operation: HookOperation,
    pub files: Option<&'a [String]>,
}

/// Why a hook fires: the target that matched, or that could not be decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Matched {
    Package(String),
    Path {
        target: String,
        file: String,
    },
    /// A `Path` trigger against a package whose file list is unknown.
    Undecided {
        target: String,
        package: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetType {
    Package,
    Path,
}

#[derive(Default)]
struct TriggerDraft {
    operations: Vec<HookOperation>,
    /// `Type` applies to the whole [Trigger] wherever it stands (glibc's
    /// hooks write Target before Type); resolved when the section ends.
    kind: Option<TargetType>,
    targets: Vec<String>,
}

#[derive(Default)]
struct ActionDraft {
    seen: bool,
    description: Option<String>,
    when: Option<HookWhen>,
    exec: Vec<String>,
    depends: Vec<String>,
    needs_targets: bool,
    abort_on_fail: bool,
}

fn bad(name: &str, line: usize, what: impl std::fmt::Display) -> HookError {
    HookError::Format(format!("{name}:{}: {what}", line + 1))
}

fn trigger_key(
    t: &mut TriggerDraft,
    key: &str,
    value: &str,
    name: &str,
    n: usize,
) -> Result<(), HookError> {
    match key {
        "Operation" => t.operations.push(match value {
            "Install" => HookOperation::Install,
            "Upgrade" => HookOperation::Upgrade,
            "Remove" => HookOperation::Remove,
            other => return Err(bad(name, n, format!("unknown Operation {other}"))),
        }),
        "Type" => {
            t.kind = Some(match value {
                "Package" => TargetType::Package,
                "Path" | "File" => TargetType::Path,
                other => return Err(bad(name, n, format!("unknown Type {other}"))),
            });
        }
        "Target" => t.targets.push(value.to_owned()),
        other => return Err(bad(name, n, format!("unknown Trigger key {other}"))),
    }
    Ok(())
}

fn action_key(
    a: &mut ActionDraft,
    key: &str,
    value: &str,
    name: &str,
    n: usize,
) -> Result<(), HookError> {
    match key {
        "Description" => a.description = Some(value.to_owned()),
        "When" => {
            a.when = Some(match value {
                "PreTransaction" => HookWhen::PreTransaction,
                "PostTransaction" => HookWhen::PostTransaction,
                other => return Err(bad(name, n, format!("unknown When {other}"))),
            });
        }
        "Exec" => a.exec.push(value.to_owned()),
        "Depends" => a.depends.push(value.to_owned()),
        "AbortOnFail" => a.abort_on_fail = true,
        "NeedsTargets" => a.needs_targets = true,
        other => return Err(bad(name, n, format!("unknown Action key {other}"))),
    }
    Ok(())
}

/// Parses one `.hook` file.
///
/// # Errors
/// A section or key pacman would not accept, a `[Trigger]` without
/// `Operation`, `Type` or `Target`, an `[Action]` without `When` or `Exec`.
///
/// # Panics
/// Never: the only `expect` guards a trigger that the `[Trigger]` line
/// just pushed.
pub fn parse(name: &str, text: &str) -> Result<Hook, HookError> {
    let mut triggers: Vec<TriggerDraft> = Vec::new();
    let mut action = ActionDraft::default();
    let mut section = "";
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(s) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = match s {
                "Trigger" => {
                    triggers.push(TriggerDraft::default());
                    "Trigger"
                }
                "Action" => {
                    action.seen = true;
                    "Action"
                }
                other => return Err(bad(name, n, format!("unknown section [{other}]"))),
            };
            continue;
        }
        // `AbortOnFail` and `NeedsTargets` are bare flags.
        let (key, value) = line.split_once('=').unwrap_or((line, ""));
        let (key, value) = (key.trim(), value.trim());
        match section {
            "Trigger" => {
                let t = triggers.last_mut().expect("a [Trigger] section was opened");
                trigger_key(t, key, value, name, n)?;
            }
            "Action" => action_key(&mut action, key, value, name, n)?,
            _ => return Err(bad(name, n, "key outside a section")),
        }
    }
    if !action.seen {
        return Err(HookError::Format(format!("{name}: no [Action] section")));
    }
    let when = action
        .when
        .ok_or_else(|| HookError::Format(format!("{name}: [Action] has no When")))?;
    if action.exec.is_empty() {
        return Err(HookError::Format(format!("{name}: [Action] has no Exec")));
    }
    if triggers.is_empty() {
        return Err(HookError::Format(format!("{name}: no [Trigger] section")));
    }
    let triggers = triggers
        .into_iter()
        .map(|t| {
            let (Some(kind), false, false) =
                (t.kind, t.operations.is_empty(), t.targets.is_empty())
            else {
                return Err(HookError::Format(format!(
                    "{name}: a [Trigger] needs Operation, Type and Target"
                )));
            };
            Ok(Trigger {
                operations: t.operations,
                targets: t
                    .targets
                    .into_iter()
                    .map(|v| match kind {
                        TargetType::Package => HookTarget::Package(v),
                        TargetType::Path => HookTarget::Path(v),
                    })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Hook {
        name: name.to_owned(),
        description: action.description,
        when,
        triggers,
        exec: action.exec,
        depends: action.depends,
        needs_targets: action.needs_targets,
        abort_on_fail: action.abort_on_fail,
    })
}

/// The hook directories under `root`, in pacman's precedence: `/etc` wins.
#[must_use]
pub fn hook_dirs(root: &Path) -> [PathBuf; 2] {
    [
        root.join("usr/share/libalpm/hooks"),
        root.join("etc/pacman.d/hooks"),
    ]
}

/// Every hook an installation would consider, by file name, `/etc`
/// overriding `/usr`. Unparseable files are skipped with their error in
/// the second list (pacman warns and skips too).
#[must_use]
pub fn load(root: &Path) -> (Vec<Hook>, Vec<String>) {
    let mut by_name: std::collections::BTreeMap<String, Result<Hook, String>> =
        std::collections::BTreeMap::new();
    for dir in hook_dirs(root) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !std::path::Path::new(name)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("hook"))
            {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(err) => {
                    by_name.insert(name.to_owned(), Err(format!("{}: {err}", path.display())));
                    continue;
                }
            };
            by_name.insert(
                name.to_owned(),
                parse(name, &text).map_err(|e| e.to_string()),
            );
        }
    }
    let mut hooks = Vec::new();
    let mut errors = Vec::new();
    for (_, r) in by_name {
        match r {
            Ok(h) => hooks.push(h),
            Err(e) => errors.push(e),
        }
    }
    (hooks, errors)
}

impl Hook {
    /// Why this hook would fire for the transaction, if it would.
    #[must_use]
    pub fn triggered_by(&self, transaction: &[TransactionPackage<'_>]) -> Option<Matched> {
        let mut undecided = None;
        for t in &self.triggers {
            for p in transaction {
                if !t.operations.contains(&p.operation) {
                    continue;
                }
                for target in &t.targets {
                    match target {
                        HookTarget::Package(g) => {
                            if glob_match(g, p.name) {
                                return Some(Matched::Package(p.name.to_owned()));
                            }
                        }
                        HookTarget::Path(g) => match p.files {
                            Some(files) => {
                                if let Some(f) = files
                                    .iter()
                                    .find(|f| glob_match(g, f.trim_start_matches('/')))
                                {
                                    return Some(Matched::Path {
                                        target: g.clone(),
                                        file: f.clone(),
                                    });
                                }
                            }
                            None => {
                                undecided.get_or_insert(Matched::Undecided {
                                    target: g.clone(),
                                    package: p.name.to_owned(),
                                });
                            }
                        },
                    }
                }
            }
        }
        undecided
    }
}

/// Shell-style glob as pacman applies to hook targets: `*` (any run,
/// slashes included — pacman does not use `FNM_PATHNAME` here), `?`, `[…]`.
#[must_use]
pub fn glob_match(pattern: &str, text: &str) -> bool {
    fn rec(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => (0..=t.len()).any(|i| rec(rest, &t[i..])),
            Some(('?', rest)) => !t.is_empty() && rec(rest, &t[1..]),
            Some(('[', rest)) => {
                let Some(close) = rest.iter().position(|c| *c == ']') else {
                    return !t.is_empty() && t[0] == '[' && rec(rest, &t[1..]);
                };
                let (class, after) = rest.split_at(close);
                let after = &after[1..];
                let Some((&c, t_rest)) = t.split_first() else {
                    return false;
                };
                let (negate, class) = match class.split_first() {
                    Some(('!' | '^', cls)) => (true, cls),
                    _ => (false, class),
                };
                let mut hit = false;
                let mut i = 0;
                while i < class.len() {
                    if i + 2 < class.len() && class[i + 1] == '-' {
                        if class[i] <= c && c <= class[i + 2] {
                            hit = true;
                        }
                        i += 3;
                    } else {
                        if class[i] == c {
                            hit = true;
                        }
                        i += 1;
                    }
                }
                hit != negate && rec(after, t_rest)
            }
            Some((&c, rest)) => t.first() == Some(&c) && rec(rest, &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    rec(&p, &t)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MKINITCPIO: &str = r"
[Trigger]
Type = Path
Operation = Install
Operation = Upgrade
Target = usr/lib/modules/*/vmlinuz

[Trigger]
Type = Package
Operation = Install
Operation = Upgrade
Target = mkinitcpio
Target = mkinitcpio-git

[Action]
Description = Updating linux initcpios...
When = PostTransaction
Exec = /usr/share/libalpm/scripts/mkinitcpio install
NeedsTargets
";

    #[test]
    fn parses_pacmans_own_format() {
        let h = parse("90-mkinitcpio-install.hook", MKINITCPIO).unwrap();
        assert_eq!(h.when, HookWhen::PostTransaction);
        assert_eq!(h.triggers.len(), 2);
        assert_eq!(
            h.triggers[0].targets,
            vec![HookTarget::Path("usr/lib/modules/*/vmlinuz".into())]
        );
        assert_eq!(h.triggers[1].targets.len(), 2);
        assert!(h.needs_targets);
        assert_eq!(
            h.exec,
            vec!["/usr/share/libalpm/scripts/mkinitcpio install".to_owned()]
        );
        // glibc's hooks write Target before Type; the type covers the whole trigger.
        let g = parse("12-glibc-remove-iconvconfig-cache.hook", "[Trigger]\nOperation = Remove\nTarget = glibc\nType = Package\n\n[Action]\nDepends = coreutils\nDescription = Removing iconv module configuration cache...\nExec = /usr/bin/rm --force /usr/lib/gconv/gconv-modules.cache\nWhen = PreTransaction\n").unwrap();
        assert_eq!(
            g.triggers[0].targets,
            vec![HookTarget::Package("glibc".into())]
        );
        assert_eq!(g.depends, vec!["coreutils".to_owned()]);
        assert!(parse("x.hook", "[Action]\nWhen = PostTransaction\nExec = true\n").is_err());
        assert!(parse(
            "x.hook",
            "[Trigger]\nType = Package\nOperation = Install\nTarget = a\n[Action]\nExec = true\n"
        )
        .is_err());
    }

    #[test]
    fn a_transaction_triggers_by_package_name_or_by_a_file_it_ships() {
        let h = parse("90-mkinitcpio-install.hook", MKINITCPIO).unwrap();
        let linux_files = vec!["usr/lib/modules/7.2.4-arch1-2/vmlinuz".to_owned()];
        let linux = TransactionPackage {
            name: "linux",
            operation: HookOperation::Upgrade,
            files: Some(&linux_files),
        };
        assert_eq!(
            h.triggered_by(std::slice::from_ref(&linux)),
            Some(Matched::Path {
                target: "usr/lib/modules/*/vmlinuz".into(),
                file: "usr/lib/modules/7.2.4-arch1-2/vmlinuz".into()
            })
        );
        let mk = TransactionPackage {
            name: "mkinitcpio",
            operation: HookOperation::Install,
            files: Some(&[]),
        };
        assert_eq!(
            h.triggered_by(&[mk]),
            Some(Matched::Package("mkinitcpio".into()))
        );
        let zlib_files = vec!["/usr/lib/libz.so.1".to_owned()];
        let zlib = TransactionPackage {
            name: "zlib",
            operation: HookOperation::Upgrade,
            files: Some(&zlib_files),
        };
        assert_eq!(h.triggered_by(&[zlib]), None);
        // A Remove-only transaction does not trigger an install hook.
        let rm = TransactionPackage {
            name: "mkinitcpio",
            operation: HookOperation::Remove,
            files: None,
        };
        assert_eq!(h.triggered_by(&[rm]), None);
        // Without a file list a Path trigger is undecided, not silent.
        let unknown = TransactionPackage {
            name: "linux",
            operation: HookOperation::Upgrade,
            files: None,
        };
        assert!(matches!(
            h.triggered_by(&[unknown]),
            Some(Matched::Undecided { .. })
        ));
    }

    #[test]
    fn globs_like_pacman() {
        assert!(glob_match(
            "usr/lib/modules/*/vmlinuz",
            "usr/lib/modules/7.2.4-arch1-2/vmlinuz"
        ));
        assert!(glob_match(
            "usr/share/glib-2.0/schemas/*.xml",
            "usr/share/glib-2.0/schemas/org.gnome.desktop.gschema.xml"
        ));
        assert!(!glob_match(
            "usr/share/glib-2.0/schemas/*.xml",
            "usr/share/glib-2.0/schemas/"
        ));
        assert!(glob_match("mkinitcpio*", "mkinitcpio-git"));
        assert!(glob_match("linux[0-9]*", "linux612"));
        assert!(!glob_match("linux[!0-9]*", "linux612"));
        assert!(glob_match("a?c", "abc") && !glob_match("a?c", "ac"));
    }

    #[test]
    fn etc_overrides_usr_by_file_name() {
        let root = std::env::temp_dir().join(format!("pkg-hooks-{}", std::process::id()));
        let usr = root.join("usr/share/libalpm/hooks");
        let etc = root.join("etc/pacman.d/hooks");
        std::fs::create_dir_all(&usr).unwrap();
        std::fs::create_dir_all(&etc).unwrap();
        std::fs::write(usr.join("90-mkinitcpio-install.hook"), MKINITCPIO).unwrap();
        std::fs::write(usr.join("30-systemd-update.hook"), "[Trigger]\nType = Package\nOperation = Upgrade\nTarget = systemd\n[Action]\nWhen = PostTransaction\nExec = /usr/bin/systemctl daemon-reload\n").unwrap();
        std::fs::write(
            etc.join("90-mkinitcpio-install.hook"),
            MKINITCPIO.replace("PostTransaction", "PreTransaction"),
        )
        .unwrap();
        std::fs::write(etc.join("broken.hook"), "nonsense").unwrap();
        let (hooks, errors) = load(&root);
        assert_eq!(
            hooks.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(),
            vec!["30-systemd-update.hook", "90-mkinitcpio-install.hook"]
        );
        assert_eq!(
            hooks[1].when,
            HookWhen::PreTransaction,
            "/etc overrides /usr"
        );
        assert_eq!(errors.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
