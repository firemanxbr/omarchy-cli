//! Promotion gate: decides from recorded evidence whether `from` may be
//! promoted into `to`, instead of by the calendar.
//!
//! The evidence is what the pipeline records per architecture: `health`
//! events (a real pacman syncing the ring) and `abi` events (the ELF-level
//! safety check of the upgrades the ring would apply to a reference system).
//! For every architecture the latest health of `from` must be recent and not
//! an error, no health of `from` inside the soak window may have failed, and
//! a recent ABI check must not have found blockers. The soak also means age:
//! the last promotion into `from` must be at least `soak_days` old, so what
//! reaches `stable` has been served by `rc` that long (syncs of the OPR
//! channel into the ring do not reset the clock). A ring with nothing
//! rendered for an architecture (`warn`) is not evidence against it. The
//! security layer is evidence too: a package `to` serves clean that `from`
//! would replace with a version under an open advisory (exact match,
//! medium or worse, or exploited in the wild) blocks the promotion — the
//! fast-track pulls fixes forward, the gate never pushes a known hole. When
//! the head of `to` already came from the head of `from`, there is nothing
//! to promote.

use crate::client::{Api, Event};
use crate::security::{security_regressions, SecurityView};
use crate::RepoError;

pub struct GateOptions<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub arches: &'a [String],
    /// Days without a failed health check of `from` required before promoting.
    pub soak_days: u32,
    /// The latest health check of `from` must be younger than this.
    pub max_age_hours: u32,
    /// Decide and print, but record no `gate` event.
    pub dry_run: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Promote,
    /// Nothing new: the head of `to` already came from the head of `from`.
    Skip(String),
    Block(Vec<String>),
}

impl Verdict {
    /// Process exit code: 0 promote, 3 nothing to promote, 1 blocked.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Verdict::Promote => 0,
            Verdict::Skip(_) => 3,
            Verdict::Block(_) => 1,
        }
    }
}

#[derive(Debug)]
pub struct ArchEvidence {
    pub arch: String,
    pub latest_status: Option<String>,
    pub latest_age_hours: Option<f64>,
    pub checks_in_window: usize,
    pub errors_in_window: usize,
    /// Status of the latest recent `abi` check of `from`, if any was recorded.
    pub abi_status: Option<String>,
    /// Packages `to` serves clean that `from` would replace with a version under an open advisory.
    pub security_regressions: usize,
}

#[derive(Debug)]
pub struct GateReport {
    pub verdict: Verdict,
    pub evidence: Vec<ArchEvidence>,
}

/// Pure decision: `events` are `health` and `abi` events (any ring), `now`
/// unix seconds, `from_promoted_at` when the content of `from` last arrived
/// there by promotion (unix seconds; `None` when `from` was never promoted
/// into, e.g. `edge`), `security` the regressions per architecture
/// (`security::security_regressions`, one list per entry of `opts.arches`).
#[must_use]
pub fn evaluate(
    events: &[Event],
    now: i64,
    from_head: Option<u64>,
    to_source: Option<u64>,
    from_promoted_at: Option<i64>,
    security: &[Vec<String>],
    opts: &GateOptions<'_>,
) -> GateReport {
    let mut reasons = Vec::new();
    let mut evidence = Vec::new();
    let window = i64::from(opts.soak_days) * 86_400;
    let max_age = i64::from(opts.max_age_hours) * 3_600;

    if let Some(reason) = soak_age_reason(now, from_promoted_at, opts) {
        reasons.push(reason);
    }

    for (i, arch) in opts.arches.iter().enumerate() {
        let regressions = security.get(i).map_or(&[][..], Vec::as_slice);
        for r in regressions {
            reasons.push(format!("{arch}: {r}"));
        }
        let mut of_arch: Vec<&Event> = events
            .iter()
            .filter(|e| {
                e.kind == "health"
                    && e.ring.as_deref() == Some(opts.from)
                    && e.source.as_deref() == Some(arch.as_str())
            })
            .collect();
        of_arch.sort_by_key(|e| std::cmp::Reverse(e.id));
        let latest = of_arch.first().copied();
        let latest_age = latest
            .and_then(|e| parse_iso8601(&e.created_at))
            .map(|t| now - t);
        let in_window: Vec<&Event> = of_arch
            .iter()
            .copied()
            .filter(|e| parse_iso8601(&e.created_at).is_some_and(|t| now - t <= window))
            .collect();
        let errors = in_window.iter().filter(|e| e.status == "error").count();

        match latest {
            None => reasons.push(format!("{arch}: no health check of {} recorded", opts.from)),
            Some(e) if e.status == "error" => {
                reasons.push(format!(
                    "{arch}: latest health of {} failed — {}",
                    opts.from, e.summary
                ));
            }
            Some(_) => {
                if latest_age.is_none_or(|age| age > max_age) {
                    reasons.push(format!(
                        "{arch}: latest health of {} is older than {} h",
                        opts.from, opts.max_age_hours
                    ));
                }
            }
        }
        if errors > 0 {
            reasons.push(format!(
                "{arch}: {errors} failed health check(s) of {} in the last {} day(s)",
                opts.from, opts.soak_days
            ));
        }
        // ABI: the latest recent check decides; an old or missing one is not evidence.
        let abi = events
            .iter()
            .filter(|e| {
                e.kind == "abi"
                    && e.ring.as_deref() == Some(opts.from)
                    && e.source.as_deref() == Some(arch.as_str())
                    && parse_iso8601(&e.created_at).is_some_and(|t| now - t <= max_age)
            })
            .max_by_key(|e| e.id);
        if let Some(e) = abi.filter(|e| e.status == "error") {
            reasons.push(format!(
                "{arch}: ABI check of {} failed — {}",
                opts.from, e.summary
            ));
        }
        evidence.push(ArchEvidence {
            arch: arch.clone(),
            latest_status: latest.map(|e| e.status.clone()),
            #[allow(clippy::cast_precision_loss)] // hours, display only
            latest_age_hours: latest_age.map(|s| s as f64 / 3600.0),
            checks_in_window: in_window.len(),
            errors_in_window: errors,
            abi_status: abi.map(|e| e.status.clone()),
            security_regressions: regressions.len(),
        });
    }

    let verdict = if !reasons.is_empty() {
        Verdict::Block(reasons)
    } else if let (Some(head), Some(src)) = (from_head, to_source) {
        if head == src {
            Verdict::Skip(format!(
                "{} already serves the head of {} (release {head})",
                opts.to, opts.from
            ))
        } else {
            Verdict::Promote
        }
    } else if from_head.is_none() {
        Verdict::Block(vec![format!("{} has no release", opts.from)])
    } else {
        Verdict::Promote
    };
    GateReport { verdict, evidence }
}

/// Soak = age: what is in `from` must have been there for the whole window.
fn soak_age_reason(
    now: i64,
    from_promoted_at: Option<i64>,
    opts: &GateOptions<'_>,
) -> Option<String> {
    let window = i64::from(opts.soak_days) * 86_400;
    let at = from_promoted_at?;
    let age = now - at;
    if window == 0 || age >= window {
        return None;
    }
    #[allow(clippy::cast_precision_loss)] // hours, display only
    Some(format!(
        "{}'s content is {:.1} h old; the soak needs {} day(s)",
        opts.from,
        age as f64 / 3600.0,
        opts.soak_days
    ))
}

/// Fetches the evidence, decides, records a `gate` event and prints the report.
pub fn run(api: &Api, opts: &GateOptions<'_>) -> Result<GateReport, RepoError> {
    let mut events = api.events("health", 200)?;
    events.extend(api.events("abi", 200)?);
    let from_head = api
        .history(opts.from)?
        .releases
        .iter()
        .find(|r| r.is_head != 0)
        .map(|r| r.id);
    let to_source = last_promotion_source(&api.history(opts.to)?.releases);
    let from_history = api.history(opts.from)?.releases;
    let from_promoted_at = last_promotion(&from_history).and_then(|r| parse_iso8601(&r.created_at));
    let now = now_unix();
    // The security layer's view of `from`, per architecture: what a
    // promotion would carry into `to` that `to` serves clean today.
    let mut security = Vec::new();
    for arch in opts.arches {
        let view: SecurityView = serde_json::from_value(
            api.get_json(&format!("/security?ring={}&arch={arch}", opts.from))?,
        )?;
        security.push(security_regressions(&view, opts.to, "medium"));
    }
    let report = evaluate(
        &events,
        now,
        from_head,
        to_source,
        from_promoted_at,
        &security,
        opts,
    );

    let (status, summary) = match &report.verdict {
        Verdict::Promote => (
            "ok",
            format!("{} → {}: evidence OK, promoting", opts.from, opts.to),
        ),
        Verdict::Skip(why) => (
            "warn",
            format!("{} → {}: nothing to promote — {why}", opts.from, opts.to),
        ),
        Verdict::Block(reasons) => (
            "error",
            format!(
                "{} → {}: blocked — {}",
                opts.from,
                opts.to,
                reasons.join("; ")
            ),
        ),
    };
    println!("{summary}");
    for e in &report.evidence {
        println!(
            "  {:<8} health {} ({}) · {} check(s) in {} day(s), {} failed · abi {} · security regressions {}",
            e.arch,
            e.latest_status.as_deref().unwrap_or("none"),
            e.latest_age_hours
                .map_or("n/a".to_owned(), |h| format!("{h:.1} h ago")),
            e.checks_in_window,
            opts.soak_days,
            e.errors_in_window,
            e.abi_status.as_deref().unwrap_or("not checked"),
            e.security_regressions
        );
    }
    if opts.dry_run {
        return Ok(report);
    }
    api.post_event(&serde_json::json!({
        "kind": "gate",
        "ring": opts.to,
        "source": opts.from,
        "status": status,
        "summary": summary,
        "payload": {
            "from": opts.from, "to": opts.to, "from_head": from_head, "to_source": to_source,
            "soak_days": opts.soak_days, "max_age_hours": opts.max_age_hours,
            "verdict": match &report.verdict { Verdict::Promote => "promote", Verdict::Skip(_) => "skip", Verdict::Block(_) => "block" },
            "reasons": match &report.verdict { Verdict::Block(r) => r.clone(), _ => Vec::new() },
            "evidence": report.evidence.iter().map(|e| serde_json::json!({
                "arch": e.arch, "latest_status": e.latest_status, "latest_age_hours": e.latest_age_hours,
                "checks_in_window": e.checks_in_window, "errors_in_window": e.errors_in_window,
                "abi_status": e.abi_status, "security_regressions": e.security_regressions,
            })).collect::<Vec<_>>(),
        }
    }))?;
    Ok(report)
}

/// The last promotion into a ring: walk from the head through releases
/// without a `source_id` (syncs of the OPR channel into the ring) until one
/// has it (promotions and rollbacks re-pin with one).
fn last_promotion(history: &[crate::client::HistoryEntry]) -> Option<&crate::client::HistoryEntry> {
    let mut cur = history.iter().find(|r| r.is_head != 0);
    while let Some(r) = cur {
        if r.source_id.is_some() {
            return Some(r);
        }
        cur = r.parent_id.and_then(|p| history.iter().find(|x| x.id == p));
    }
    None
}

/// The release the last promotion into a ring copied from.
fn last_promotion_source(history: &[crate::client::HistoryEntry]) -> Option<u64> {
    last_promotion(history).and_then(|r| r.source_id)
}

#[allow(clippy::cast_possible_wrap)] // fits until the year 292 billion
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → unix seconds (what D1 records).
#[must_use]
pub fn parse_iso8601(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let field = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (field(0..4)?, field(5..7)?, field(8..10)?);
    let (hour, minute, second) = (field(11..13)?, field(14..16)?, field(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days from civil (Howard Hinnant), proleptic Gregorian.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: u64, ring: &str, arch: &str, status: &str, at: &str) -> Event {
        kind_ev("health", id, ring, arch, status, at)
    }

    fn kind_ev(kind: &str, id: u64, ring: &str, arch: &str, status: &str, at: &str) -> Event {
        Event {
            id,
            kind: kind.into(),
            ring: Some(ring.into()),
            source: Some(arch.into()),
            status: status.into(),
            summary: format!("{ring} {arch}: {status}"),
            payload: None,
            duration_ms: None,
            created_at: at.into(),
        }
    }

    fn opts(arches: &[String], soak: u32) -> GateOptions<'_> {
        GateOptions {
            from: "rc",
            to: "stable",
            arches,
            soak_days: soak,
            max_age_hours: 24,
            dry_run: true,
        }
    }

    const NOW: i64 = 1_789_197_600; // 2026-09-12T07:20:00Z

    #[test]
    fn iso8601_matches_known_epochs() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(parse_iso8601("2026-09-12T07:20:00.123Z"), Some(NOW));
        assert_eq!(parse_iso8601("garbage"), None);
    }

    #[test]
    fn promotes_on_fresh_green_evidence() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let events = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "aarch64", "ok", "2026-09-12T06:01:00Z"),
            ev(3, "edge", "x86_64", "error", "2026-09-12T06:02:00Z"), // other ring, ignored
        ];
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            Some(7),
            None,
            &[],
            &opts(&arches, 3),
        );
        assert_eq!(r.verdict, Verdict::Promote);
    }

    #[test]
    fn nothing_rendered_is_not_evidence_against() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let events = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "aarch64", "warn", "2026-09-12T06:01:00Z"),
        ];
        assert_eq!(
            evaluate(&events, NOW, Some(10), None, None, &[], &opts(&arches, 3)).verdict,
            Verdict::Promote
        );
    }

    #[test]
    fn blocks_on_latest_failure_or_stale_or_missing_evidence() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let failed = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "aarch64", "error", "2026-09-12T06:01:00Z"),
        ];
        let Verdict::Block(reasons) =
            evaluate(&failed, NOW, Some(10), None, None, &[], &opts(&arches, 3)).verdict
        else {
            panic!("expected block")
        };
        assert!(reasons
            .iter()
            .any(|r| r.contains("aarch64: latest health of rc failed")));

        let stale = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-10T06:00:00Z"),
            ev(2, "rc", "aarch64", "ok", "2026-09-12T06:01:00Z"),
        ];
        let Verdict::Block(reasons) =
            evaluate(&stale, NOW, Some(10), None, None, &[], &opts(&arches, 3)).verdict
        else {
            panic!("expected block")
        };
        assert!(reasons[0].contains("older than 24 h"), "{reasons:?}");

        let missing = vec![ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z")];
        assert!(matches!(
            evaluate(&missing, NOW, Some(10), None, None, &[], &opts(&arches, 3)).verdict,
            Verdict::Block(_)
        ));
    }

    #[test]
    fn soak_window_counts_failures_and_forgets_old_ones() {
        let arches = vec!["x86_64".to_owned()];
        let events = vec![
            ev(3, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "x86_64", "error", "2026-09-11T06:00:00Z"), // 1 day ago
            ev(1, "rc", "x86_64", "error", "2026-09-01T06:00:00Z"), // 11 days ago
        ];
        let r = evaluate(&events, NOW, Some(10), None, None, &[], &opts(&arches, 3));
        assert_eq!(r.evidence[0].errors_in_window, 1);
        assert!(matches!(r.verdict, Verdict::Block(_)));
        let r = evaluate(&events, NOW, Some(10), None, None, &[], &opts(&arches, 0));
        assert_eq!(
            r.evidence[0].errors_in_window, 0,
            "a zero-day window only sees the latest"
        );
        assert_eq!(r.verdict, Verdict::Promote);
    }

    #[test]
    fn recent_abi_blockers_block_but_old_ones_do_not() {
        let arches = vec!["x86_64".to_owned()];
        let mut events = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            kind_ev("abi", 2, "rc", "x86_64", "error", "2026-09-12T06:05:00Z"),
        ];
        let r = evaluate(&events, NOW, Some(10), None, None, &[], &opts(&arches, 0));
        assert!(
            matches!(&r.verdict, Verdict::Block(reasons) if reasons[0].contains("ABI check of rc failed"))
        );
        assert_eq!(r.evidence[0].abi_status.as_deref(), Some("error"));

        events[1].created_at = "2026-09-01T06:05:00Z".into(); // stale: not evidence
        let r = evaluate(&events, NOW, Some(10), None, None, &[], &opts(&arches, 0));
        assert_eq!(r.verdict, Verdict::Promote);
        assert_eq!(r.evidence[0].abi_status, None);
    }

    #[test]
    fn soak_requires_the_source_content_to_be_old_enough() {
        let arches = vec!["x86_64".to_owned()];
        let events = vec![ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z")];
        // promoted into rc one hour ago: too fresh for a 3-day soak
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            None,
            Some(NOW - 3600),
            &[],
            &opts(&arches, 3),
        );
        assert!(
            matches!(&r.verdict, Verdict::Block(reasons) if reasons[0].contains("soak needs 3 day")),
            "{:?}",
            r.verdict
        );
        // promoted four days ago: fine
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            None,
            Some(NOW - 4 * 86_400),
            &[],
            &opts(&arches, 3),
        );
        assert_eq!(r.verdict, Verdict::Promote);
        // no soak requested (into rc): age is irrelevant
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            None,
            Some(NOW - 60),
            &[],
            &opts(&arches, 0),
        );
        assert_eq!(r.verdict, Verdict::Promote);
    }

    #[test]
    fn last_promotion_is_found_through_sync_releases() {
        let entry = |id: u64, parent: Option<u64>, source: Option<u64>, head: u8| {
            crate::client::HistoryEntry {
                id,
                seq: id,
                parent_id: parent,
                source_id: source,
                note: None,
                created_at: String::new(),
                package_count: 0,
                is_head: head,
            }
        };
        // head 12 = OPR sync, parent 11 = OPR sync, parent 10 = promotion from 7
        let history = vec![
            entry(12, Some(11), None, 1),
            entry(11, Some(10), None, 0),
            entry(10, Some(9), Some(7), 0),
            entry(9, None, Some(3), 0),
        ];
        assert_eq!(last_promotion_source(&history), Some(7));
        assert_eq!(last_promotion_source(&[entry(1, None, None, 1)]), None);
    }

    #[test]
    fn skips_when_target_already_serves_the_source_head() {
        let arches = vec!["x86_64".to_owned()];
        let events = vec![ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z")];
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            Some(10),
            None,
            &[],
            &opts(&arches, 0),
        );
        assert!(matches!(r.verdict, Verdict::Skip(_)));
        assert_eq!(r.verdict.exit_code(), 3);
        let r = evaluate(&events, NOW, None, None, None, &[], &opts(&arches, 0));
        assert!(matches!(r.verdict, Verdict::Block(_)));
    }

    #[test]
    fn a_security_regression_blocks_and_is_counted_per_arch() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let events = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:20:00Z"),
            ev(2, "rc", "aarch64", "ok", "2026-09-12T06:20:00Z"),
        ];
        let security = vec![vec!["djvulibre 3.5.30.1-1 (high; arch:AVG-2907:djvulibre) would replace clean 3.5.29-1 in rc".to_owned()], vec![]];
        let r = evaluate(
            &events,
            NOW,
            Some(10),
            None,
            None,
            &security,
            &opts(&arches, 0),
        );
        match r.verdict {
            Verdict::Block(reasons) => {
                assert_eq!(reasons.len(), 1);
                assert!(reasons[0].starts_with("x86_64: djvulibre"), "{reasons:?}");
            }
            other => panic!("expected a block, got {other:?}"),
        }
        assert_eq!(r.evidence[0].security_regressions, 1);
        assert_eq!(r.evidence[1].security_regressions, 0);
    }
}
