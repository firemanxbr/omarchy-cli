// Every .hook an archlinux:base image ships parses. The harness exports
// them into OMARCHY_HOOKS_ROOT (a root with usr/share/libalpm/hooks);
// without it the test is a no-op.
#[test]
fn every_hook_of_a_real_arch_system_parses() {
    let Ok(root) = std::env::var("OMARCHY_HOOKS_ROOT") else {
        return;
    };
    let (hooks, errors) = pkg_hooks::load(std::path::Path::new(&root));
    assert!(errors.is_empty(), "{errors:?}");
    assert!(hooks.len() >= 10, "only {} hooks under {root}", hooks.len());
}
