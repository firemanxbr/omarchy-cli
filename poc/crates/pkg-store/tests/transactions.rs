mod common;

use std::os::unix::fs::PermissionsExt;

use common::*;
use pkg_store::StoreError;

#[test]
fn installs_real_package_and_records_state() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let archive = fixture("zlib-1:1.3.2-3-x86_64.pkg.tar.zst");

    let mut tx = store.transaction();
    tx.install(&archive, manifest(&archive));
    let report = tx.commit().unwrap();
    assert_eq!(
        report.installed,
        [("zlib".to_owned(), "1:1.3.2-3".to_owned())]
    );

    assert!(exists(root, "/usr/lib/libz.so.1.3.2"));
    let link = std::fs::read_link(root.join("usr/lib/libz.so.1")).unwrap();
    assert_eq!(
        link.to_str(),
        Some("libz.so.1.3.2"),
        "symlinks are recreated verbatim"
    );
    assert!(!exists(root, "/.PKGINFO") && !exists(root, "/.MTREE"));

    let pkg = store.package("zlib").unwrap().unwrap();
    assert_eq!(pkg.version, "1:1.3.2-3");
    assert!(pkg.installed_at > 0);
    let owner = store.owner_of("/usr/lib/libz.so.1.3.2").unwrap().unwrap();
    assert_eq!(owner.owner, "zlib");
    assert_eq!(owner.mode, 0o755);
    assert_eq!(owner.sha256.as_ref().map(String::len), Some(64));
    assert_eq!(store.providers_of("libz.so").unwrap(), ["zlib"]);
    assert_eq!(store.providers_of("zlib").unwrap(), ["zlib"]);
    assert!(store
        .files_of("zlib")
        .unwrap()
        .contains(&"/usr/include/zlib.h".to_owned()));
    assert_clean(root);
}

#[test]
fn remove_deletes_files_and_prunes_empty_dirs() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let archive = make_pkg(
        root,
        "foo",
        "1.0-1",
        &[],
        &[
            exe("/usr/bin/foo", "#!/bin/sh\n"),
            file("/usr/share/foo/data.txt", "x"),
        ],
    );
    let mut tx = store.transaction();
    tx.install(&archive, manifest(&archive));
    tx.commit().unwrap();
    assert!(exists(root, "/usr/share/foo/data.txt"));

    let mut tx = store.transaction();
    tx.remove("foo");
    let report = tx.commit().unwrap();
    assert_eq!(report.removed, ["foo"]);

    assert!(!exists(root, "/usr/bin/foo"));
    assert!(
        !exists(root, "/usr/share/foo"),
        "empty owned dirs are pruned"
    );
    assert!(store.package("foo").unwrap().is_none());
    assert!(store.owner_of("/usr/bin/foo").unwrap().is_none());
    assert!(store.providers_of("foo").unwrap().is_empty());
    assert_clean(root);
}

#[test]
fn remove_unknown_package_fails_before_touching_anything() {
    let (tmp, store) = open_store();
    let mut tx = store.transaction();
    tx.remove("ghost");
    assert!(matches!(tx.commit().unwrap_err(), StoreError::NotInstalled(n) if n == "ghost"));
    assert_clean(tmp.path());
}

#[test]
fn upgrade_replaces_changed_removes_dropped_adds_new() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let v1 = make_pkg(
        root,
        "app",
        "1.0-1",
        &[],
        &[
            exe("/usr/bin/app", "v1"),
            file("/usr/share/app/same.txt", "same"),
            file("/usr/share/app/old-only.txt", "old"),
            file("/usr/share/app/legacy/gone.txt", "gone"),
        ],
    );
    let v2 = make_pkg(
        root,
        "app",
        "2.0-1",
        &[],
        &[
            exe("/usr/bin/app", "v2"),
            file("/usr/share/app/same.txt", "same"),
            file("/usr/share/app/new-only.txt", "new"),
        ],
    );

    let mut tx = store.transaction();
    tx.install(&v1, manifest(&v1));
    tx.commit().unwrap();
    let mut tx = store.transaction();
    tx.install(&v2, manifest(&v2));
    let report = tx.commit().unwrap();

    assert_eq!(
        report.upgraded,
        [("app".to_owned(), "1.0-1".to_owned(), "2.0-1".to_owned())]
    );
    assert_eq!(read(root, "/usr/bin/app"), "v2");
    assert_eq!(read(root, "/usr/share/app/same.txt"), "same");
    assert_eq!(read(root, "/usr/share/app/new-only.txt"), "new");
    assert!(!exists(root, "/usr/share/app/old-only.txt"));
    assert!(
        !exists(root, "/usr/share/app/legacy"),
        "dirs dropped by the new version are pruned"
    );
    assert_eq!(store.package("app").unwrap().unwrap().version, "2.0-1");
    assert!(store
        .owner_of("/usr/share/app/old-only.txt")
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .owner_of("/usr/share/app/new-only.txt")
            .unwrap()
            .unwrap()
            .owner,
        "app"
    );
    assert_clean(root);
}

#[test]
fn collision_with_another_package_is_rejected_before_apply() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let a = make_pkg(root, "a", "1-1", &[], &[exe("/usr/bin/tool", "a")]);
    let b = make_pkg(
        root,
        "b",
        "1-1",
        &[],
        &[exe("/usr/bin/other", "b"), exe("/usr/bin/tool", "b")],
    );
    let mut tx = store.transaction();
    tx.install(&a, manifest(&a));
    tx.commit().unwrap();

    let mut tx = store.transaction();
    tx.install(&b, manifest(&b));
    let err = tx.commit().unwrap_err();
    match err {
        StoreError::RolledBack { source, .. } => match *source {
            StoreError::Collision { path, owner } => {
                assert_eq!(path, "/usr/bin/tool");
                assert_eq!(owner, "a");
            }
            other => panic!("unexpected {other}"),
        },
        other => panic!("unexpected {other}"),
    }
    assert_eq!(read(root, "/usr/bin/tool"), "a");
    assert!(!exists(root, "/usr/bin/other"));
    assert!(store.package("b").unwrap().is_none());
    assert_clean(root);
}

#[test]
fn untracked_file_on_disk_is_a_collision() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("etc")).unwrap();
    std::fs::write(root.join("etc/foo.conf"), "user made this").unwrap();
    let pkg = make_pkg(root, "foo", "1-1", &[], &[file("/etc/foo.conf", "pkg")]);

    let mut tx = store.transaction();
    tx.install(&pkg, manifest(&pkg));
    let err = tx.commit().unwrap_err();
    assert!(
        matches!(err, StoreError::RolledBack { ref source, .. }
            if matches!(**source, StoreError::Collision { ref owner, .. } if owner == "filesystem")),
        "{err}"
    );
    assert_eq!(read(root, "/etc/foo.conf"), "user made this");
    assert_clean(root);
}

#[test]
fn file_owned_by_package_being_removed_can_be_taken_over() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let a = make_pkg(
        root,
        "a",
        "1-1",
        &[],
        &[exe("/usr/bin/tool", "a"), file("/usr/share/a/x", "a")],
    );
    let b = make_pkg(root, "b", "1-1", &[], &[exe("/usr/bin/tool", "b")]);
    let mut tx = store.transaction();
    tx.install(&a, manifest(&a));
    tx.commit().unwrap();

    let mut tx = store.transaction();
    tx.remove("a");
    tx.install(&b, manifest(&b));
    let report = tx.commit().unwrap();
    assert_eq!(report.removed, ["a"]);
    assert_eq!(report.installed, [("b".to_owned(), "1-1".to_owned())]);
    assert_eq!(read(root, "/usr/bin/tool"), "b");
    assert!(!exists(root, "/usr/share/a"));
    assert_eq!(store.owner_of("/usr/bin/tool").unwrap().unwrap().owner, "b");
    assert!(store.package("a").unwrap().is_none());
    assert_clean(root);
}

#[test]
fn io_failure_mid_apply_rolls_back_everything() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    // `/usr/locked` exists and is read-only, so placing x2 must fail after x1
    // was already placed.
    let locked = root.join("usr/locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let pkg = make_pkg(
        root,
        "foo",
        "1-1",
        &[],
        &[exe("/usr/bin/x1", "1"), file("/usr/locked/x2", "2")],
    );

    let mut tx = store.transaction();
    tx.install(&pkg, manifest(&pkg));
    let err = tx.commit().unwrap_err();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(err, StoreError::RolledBack { .. }), "{err}");
    assert!(
        !exists(root, "/usr/bin/x1"),
        "already-placed file was rolled back"
    );
    assert!(!exists(root, "/usr/locked/x2"));
    assert!(store.package("foo").unwrap().is_none());
    assert_clean(root);
}

#[test]
fn crash_during_apply_is_rolled_back_on_next_open() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let v1 = make_pkg(
        root,
        "app",
        "1-1",
        &[],
        &[exe("/usr/bin/app", "v1"), file("/usr/share/app/a", "a1")],
    );
    let v2 = make_pkg(
        root,
        "app",
        "2-1",
        &[],
        &[
            exe("/usr/bin/app", "v2"),
            file("/usr/share/app/a", "a2"),
            file("/usr/share/app/b", "b2"),
        ],
    );
    let mut tx = store.transaction();
    tx.install(&v1, manifest(&v1));
    tx.commit().unwrap();

    let mut tx = store.transaction();
    tx.install(&v2, manifest(&v2));
    tx.simulate_crash_after(2);
    assert!(matches!(
        tx.commit().unwrap_err(),
        StoreError::SimulatedCrash(2)
    ));
    // The "dead" process left a half-applied upgrade behind.
    assert_eq!(read(root, "/usr/bin/app"), "v2");
    assert!(exists(root, "/usr/bin/app.omarchy-old"));
    drop(store);

    let store = reopen(&tmp);
    assert_eq!(read(root, "/usr/bin/app"), "v1");
    assert_eq!(read(root, "/usr/share/app/a"), "a1");
    assert!(!exists(root, "/usr/share/app/b"));
    assert_eq!(store.package("app").unwrap().unwrap().version, "1-1");
    assert_clean(root);
}

#[test]
fn crash_after_commit_finishes_cleanup_on_next_open() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let v1 = make_pkg(
        root,
        "app",
        "1-1",
        &[],
        &[exe("/usr/bin/app", "v1"), file("/usr/share/app/old", "x")],
    );
    let v2 = make_pkg(root, "app", "2-1", &[], &[exe("/usr/bin/app", "v2")]);
    let mut tx = store.transaction();
    tx.install(&v1, manifest(&v1));
    tx.commit().unwrap();

    let mut tx = store.transaction();
    tx.install(&v2, manifest(&v2));
    tx.simulate_crash_after_commit();
    assert!(matches!(
        tx.commit().unwrap_err(),
        StoreError::SimulatedCrash(_)
    ));
    assert!(exists(root, "/usr/bin/app.omarchy-old"));
    assert!(exists(root, "/usr/share/app/old.omarchy-old"));
    drop(store);

    let store = reopen(&tmp);
    assert_eq!(read(root, "/usr/bin/app"), "v2", "committed state is kept");
    assert!(
        !exists(root, "/usr/share/app"),
        "dropped dir pruned during deferred cleanup"
    );
    assert_eq!(store.package("app").unwrap().unwrap().version, "2-1");
    assert_clean(root);
}

#[test]
fn modified_backup_file_gets_pacnew_and_untouched_one_is_replaced() {
    let (tmp, store) = open_store();
    let root = tmp.path();
    let backup = ["/etc/app/modified.conf", "/etc/app/pristine.conf"];
    let v1 = make_pkg(
        root,
        "app",
        "1-1",
        &backup,
        &[
            file("/etc/app/modified.conf", "v1"),
            file("/etc/app/pristine.conf", "v1"),
        ],
    );
    let v2 = make_pkg(
        root,
        "app",
        "2-1",
        &backup,
        &[
            file("/etc/app/modified.conf", "v2"),
            file("/etc/app/pristine.conf", "v2"),
        ],
    );
    let mut tx = store.transaction();
    tx.install(&v1, manifest(&v1));
    tx.commit().unwrap();
    std::fs::write(root.join("etc/app/modified.conf"), "edited by user").unwrap();

    let mut tx = store.transaction();
    tx.install(&v2, manifest(&v2));
    let report = tx.commit().unwrap();

    assert_eq!(report.pacnew, ["/etc/app/modified.conf.pacnew"]);
    assert_eq!(read(root, "/etc/app/modified.conf"), "edited by user");
    assert_eq!(read(root, "/etc/app/modified.conf.pacnew"), "v2");
    assert_eq!(read(root, "/etc/app/pristine.conf"), "v2");
    assert!(!exists(root, "/etc/app/pristine.conf.pacnew"));
    assert_clean(root);
}
