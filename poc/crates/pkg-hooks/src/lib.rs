//! libalpm hook compatibility.
//!
//! Reads `.hook` files from `/usr/share/libalpm/hooks` and `/etc/pacman.d/hooks`
//! (same precedence rules as pacman: `/etc` overrides `/usr`), matches their
//! `Trigger` sections against the transaction, and runs `Exec` in the right phase
//! (`PreTransaction` / `PostTransaction`). This is what keeps `mkinitcpio`,
//! `glib-compile-schemas`, `depmod`, `systemd-sysusers` & friends working.
//!
//! # Phase 5 deliverable

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookWhen {
    PreTransaction,
    PostTransaction,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub name: String,
    pub when: HookWhen,
    pub operations: Vec<HookOperation>,
    pub targets: Vec<HookTarget>,
    pub exec: Vec<String>,
    pub needs_targets: bool,
    pub abort_on_fail: bool,
}
