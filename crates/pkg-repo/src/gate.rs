//! Promotion gate: decides from recorded evidence whether `from` may be
//! promoted into `to`, instead of by the calendar.
//!
//! The evidence is the `health` events the pipeline posts — a real pacman
//! syncing the ring per architecture. For every architecture the latest health
//! of `from` must be recent and not an error, and no health of `from` inside
//! the soak window may have failed. A ring with nothing rendered for an
//! architecture (`warn`) is not evidence against it. When the head of `to`
//! already came from the head of `from`, there is nothing to promote.

use crate::client::{Api, Event};
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
}

#[derive(Debug)]
pub struct GateReport {
    pub verdict: Verdict,
    pub evidence: Vec<ArchEvidence>,
}

/// Pure decision: `events` are health events (any ring), `now` unix seconds.
#[must_use]
pub fn evaluate(
    events: &[Event],
    now: i64,
    from_head: Option<u64>,
    to_source: Option<u64>,
    opts: &GateOptions<'_>,
) -> GateReport {
    let mut reasons = Vec::new();
    let mut evidence = Vec::new();
    let window = i64::from(opts.soak_days) * 86_400;
    let max_age = i64::from(opts.max_age_hours) * 3_600;

    for arch in opts.arches {
        let mut of_arch: Vec<&Event> = events
            .iter()
            .filter(|e| {
                e.kind == "health"
                    && e.ring.as_deref() == Some(opts.from)
                    && e.source.as_deref() == Some(arch.as_str())
            })
            .collect();
        of_arch.sort_by(|a, b| b.id.cmp(&a.id));
        let latest = of_arch.first().copied();
        let latest_age = latest.and_then(|e| parse_iso8601(&e.created_at)).map(|t| now - t);
        let in_window: Vec<&Event> = of_arch
            .iter()
            .copied()
            .filter(|e| parse_iso8601(&e.created_at).is_some_and(|t| now - t <= window))
            .collect();
        let errors = in_window.iter().filter(|e| e.status == "error").count();

        match latest {
            None => reasons.push(format!("{arch}: no health check of {} recorded", opts.from)),
            Some(e) if e.status == "error" => {
                reasons.push(format!("{arch}: latest health of {} failed — {}", opts.from, e.summary));
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
        evidence.push(ArchEvidence {
            arch: arch.clone(),
            latest_status: latest.map(|e| e.status.clone()),
            #[allow(clippy::cast_precision_loss)] // hours, display only
            latest_age_hours: latest_age.map(|s| s as f64 / 3600.0),
            checks_in_window: in_window.len(),
            errors_in_window: errors,
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

/// Fetches the evidence, decides, records a `gate` event and prints the report.
pub fn run(api: &Api, opts: &GateOptions<'_>) -> Result<GateReport, RepoError> {
    let events = api.events("health", 200)?;
    let from_head = api.history(opts.from)?.releases.iter().find(|r| r.is_head != 0).map(|r| r.id);
    let to_source = api
        .history(opts.to)?
        .releases
        .iter()
        .find(|r| r.is_head != 0)
        .and_then(|r| r.source_id);
    let now = now_unix();
    let report = evaluate(&events, now, from_head, to_source, opts);

    let (status, summary) = match &report.verdict {
        Verdict::Promote => ("ok", format!("{} → {}: evidence OK, promoting", opts.from, opts.to)),
        Verdict::Skip(why) => ("warn", format!("{} → {}: nothing to promote — {why}", opts.from, opts.to)),
        Verdict::Block(reasons) => (
            "error",
            format!("{} → {}: blocked — {}", opts.from, opts.to, reasons.join("; ")),
        ),
    };
    println!("{summary}");
    for e in &report.evidence {
        println!(
            "  {:<8} latest {} ({}) · {} check(s) in {} day(s), {} failed",
            e.arch,
            e.latest_status.as_deref().unwrap_or("none"),
            e.latest_age_hours.map_or("n/a".to_owned(), |h| format!("{h:.1} h ago")),
            e.checks_in_window,
            opts.soak_days,
            e.errors_in_window
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
            })).collect::<Vec<_>>(),
        }
    }))?;
    Ok(report)
}

#[allow(clippy::cast_possible_wrap)] // fits until the year 292 billion
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → unix seconds (what D1 records).
#[must_use]
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant), proleptic Gregorian.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: u64, ring: &str, arch: &str, status: &str, at: &str) -> Event {
        Event {
            id,
            kind: "health".into(),
            ring: Some(ring.into()),
            source: Some(arch.into()),
            status: status.into(),
            summary: format!("{ring} {arch}: {status}"),
            payload: None,
            duration_ms: None,
            created_at: at.into(),
        }
    }

    fn opts<'a>(arches: &'a [String], soak: u32) -> GateOptions<'a> {
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
        let r = evaluate(&events, NOW, Some(10), Some(7), &opts(&arches, 3));
        assert_eq!(r.verdict, Verdict::Promote);
    }

    #[test]
    fn nothing_rendered_is_not_evidence_against() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let events = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "aarch64", "warn", "2026-09-12T06:01:00Z"),
        ];
        assert_eq!(evaluate(&events, NOW, Some(10), None, &opts(&arches, 3)).verdict, Verdict::Promote);
    }

    #[test]
    fn blocks_on_latest_failure_or_stale_or_missing_evidence() {
        let arches = vec!["x86_64".to_owned(), "aarch64".to_owned()];
        let failed = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "aarch64", "error", "2026-09-12T06:01:00Z"),
        ];
        let Verdict::Block(reasons) = evaluate(&failed, NOW, Some(10), None, &opts(&arches, 3)).verdict else {
            panic!("expected block")
        };
        assert!(reasons.iter().any(|r| r.contains("aarch64: latest health of rc failed")));

        let stale = vec![
            ev(1, "rc", "x86_64", "ok", "2026-09-10T06:00:00Z"),
            ev(2, "rc", "aarch64", "ok", "2026-09-12T06:01:00Z"),
        ];
        let Verdict::Block(reasons) = evaluate(&stale, NOW, Some(10), None, &opts(&arches, 3)).verdict else {
            panic!("expected block")
        };
        assert!(reasons[0].contains("older than 24 h"), "{reasons:?}");

        let missing = vec![ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z")];
        assert!(matches!(evaluate(&missing, NOW, Some(10), None, &opts(&arches, 3)).verdict, Verdict::Block(_)));
    }

    #[test]
    fn soak_window_counts_failures_and_forgets_old_ones() {
        let arches = vec!["x86_64".to_owned()];
        let events = vec![
            ev(3, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z"),
            ev(2, "rc", "x86_64", "error", "2026-09-11T06:00:00Z"), // 1 day ago
            ev(1, "rc", "x86_64", "error", "2026-09-01T06:00:00Z"), // 11 days ago
        ];
        let r = evaluate(&events, NOW, Some(10), None, &opts(&arches, 3));
        assert_eq!(r.evidence[0].errors_in_window, 1);
        assert!(matches!(r.verdict, Verdict::Block(_)));
        let r = evaluate(&events, NOW, Some(10), None, &opts(&arches, 0));
        assert_eq!(r.evidence[0].errors_in_window, 0, "a zero-day window only sees the latest");
        assert_eq!(r.verdict, Verdict::Promote);
    }

    #[test]
    fn skips_when_target_already_serves_the_source_head() {
        let arches = vec!["x86_64".to_owned()];
        let events = vec![ev(1, "rc", "x86_64", "ok", "2026-09-12T06:00:00Z")];
        let r = evaluate(&events, NOW, Some(10), Some(10), &opts(&arches, 0));
        assert!(matches!(r.verdict, Verdict::Skip(_)));
        assert_eq!(r.verdict.exit_code(), 3);
        let r = evaluate(&events, NOW, None, None, &opts(&arches, 0));
        assert!(matches!(r.verdict, Verdict::Block(_)));
    }
}
