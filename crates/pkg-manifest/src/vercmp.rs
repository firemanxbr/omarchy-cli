//! Port of libalpm's `alpm_pkg_vercmp` (which itself descends from rpm's
//! `rpmvercmp`). Version strings are `[epoch:]pkgver[-pkgrel]`.
//!
//! Keeping this byte-for-byte compatible with pacman matters: the resolver must
//! agree with `pacman -Q` about which of two versions is newer.

use std::cmp::Ordering;

/// A parsed Arch version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version<'a> {
    pub epoch: u64,
    pub pkgver: &'a str,
    pub pkgrel: Option<&'a str>,
}

impl<'a> Version<'a> {
    pub fn parse(s: &'a str) -> Self {
        let (epoch, rest) = match s.split_once(':') {
            Some((e, rest)) if e.chars().all(|c| c.is_ascii_digit()) && !e.is_empty() => {
                (e.parse().unwrap_or(0), rest)
            }
            _ => (0, s),
        };
        let (pkgver, pkgrel) = match rest.rsplit_once('-') {
            Some((v, r)) => (v, Some(r)),
            None => (rest, None),
        };
        Self {
            epoch,
            pkgver,
            pkgrel,
        }
    }
}

/// Compares two Arch version strings. Equivalent to `vercmp(1)`.
pub fn vercmp(a: &str, b: &str) -> Ordering {
    let va = Version::parse(a);
    let vb = Version::parse(b);

    va.epoch
        .cmp(&vb.epoch)
        .then_with(|| rpmvercmp(va.pkgver, vb.pkgver))
        .then_with(|| match (va.pkgrel, vb.pkgrel) {
            // pacman only compares pkgrel when both sides have one.
            (Some(ra), Some(rb)) => rpmvercmp(ra, rb),
            _ => Ordering::Equal,
        })
}

/// Segment-wise comparison following rpm's algorithm.
fn rpmvercmp(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }

    let mut one = a.as_bytes();
    let mut two = b.as_bytes();

    while !one.is_empty() && !two.is_empty() {
        // Skip separators (anything that is not alphanumeric).
        let sep_a = one
            .iter()
            .take_while(|c| !c.is_ascii_alphanumeric())
            .count();
        let sep_b = two
            .iter()
            .take_while(|c| !c.is_ascii_alphanumeric())
            .count();
        one = &one[sep_a..];
        two = &two[sep_b..];

        // If we ran to the end of either, we're done with the loop.
        if one.is_empty() || two.is_empty() {
            break;
        }

        // Separator count matters: "1.0" vs "1..0" — fewer separators wins.
        if sep_a != sep_b {
            return if sep_a < sep_b {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }

        // Grab the next segment: either all digits or all alphas.
        let isnum = one[0].is_ascii_digit();
        let seg_a = one
            .iter()
            .take_while(|c| {
                if isnum {
                    c.is_ascii_digit()
                } else {
                    c.is_ascii_alphabetic()
                }
            })
            .count();
        let seg_b = two
            .iter()
            .take_while(|c| {
                if isnum {
                    c.is_ascii_digit()
                } else {
                    c.is_ascii_alphabetic()
                }
            })
            .count();

        // Segment types differ: numeric segments are always newer than alpha ones.
        if seg_b == 0 {
            return if isnum {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }

        let (sa, sb) = (&one[..seg_a], &two[..seg_b]);
        one = &one[seg_a..];
        two = &two[seg_b..];

        let ord = if isnum {
            let sa = strip_leading_zeros(sa);
            let sb = strip_leading_zeros(sb);
            // Longer numeric string is bigger; equal length → lexical compare works.
            sa.len().cmp(&sb.len()).then_with(|| sa.cmp(sb))
        } else {
            sa.cmp(sb)
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }

    // Both exhausted → equal.
    if one.is_empty() && two.is_empty() {
        return Ordering::Equal;
    }

    // Whichever has remaining content: if the remainder starts with alpha, it's a
    // pre-release style suffix and loses; a numeric remainder wins.
    if one.is_empty() {
        if two[0].is_ascii_alphabetic() {
            Ordering::Greater
        } else {
            Ordering::Less
        }
    } else if one[0].is_ascii_alphabetic() {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

fn strip_leading_zeros(s: &[u8]) -> &[u8] {
    let n = s.iter().take_while(|c| **c == b'0').count();
    &s[n..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::{Equal, Greater, Less};

    // Cases taken from pacman's test/util/vercmptest.sh.
    #[test]
    fn matches_pacman_test_suite() {
        let cases = [
            ("1.5.0", "1.5.0", Equal),
            ("1.5.1", "1.5.0", Greater),
            ("1.5.1", "1.5", Greater),
            ("1.5b", "1.5", Less),
            ("1.5b", "1.5.1", Less),
            ("1.5.b", "1.5", Greater),
            ("1.5.b", "1.5.1", Less),
            ("1.0a", "1.0alpha", Less),
            ("1.0alpha", "1.0b", Less),
            ("1.0b", "1.0beta", Less),
            ("1.0beta", "1.0rc", Less),
            ("1.0rc", "1.0", Less),
            ("1.0", "1.0.0", Less),
            ("1.0.0", "1.0", Greater),
            ("1.0.1", "1.0", Greater),
            ("1.5", "1.5-1", Equal),
            ("1.5-1", "1.5", Equal),
            ("1.5-1", "1.5-2", Less),
            ("1.5-2", "1.5-1", Greater),
            ("1.5-1", "1.5.1-1", Less),
            ("1.5.1-1", "1.5-1", Greater),
            ("0:1.0", "0:1.0", Equal),
            ("0:1.0", "0:1.1", Less),
            ("1:1.0", "0:1.0", Greater),
            ("1:1.0", "0:1.1", Greater),
            ("1:1.0", "2:1.1", Less),
            ("0:1.0", "1.0", Equal),
            ("1:1.0", "1.0", Greater),
            ("1.0", "1:1.0", Less),
            ("1.0", "1.0-1", Equal),
            ("1.0a", "1.0", Less),
            ("1.0", "1.0.a", Less),
            ("1.0", "1.0a", Greater),
            ("1..0", "1.0", Greater),
            ("1..0", "1..0", Equal),
            ("01", "1", Equal),
            ("1.0.10", "1.0.9", Greater),
        ];
        for (a, b, expected) in cases {
            assert_eq!(vercmp(a, b), expected, "vercmp({a:?}, {b:?})");
            assert_eq!(
                vercmp(b, a),
                expected.reverse(),
                "vercmp({b:?}, {a:?}) (reverse)"
            );
        }
    }

    #[test]
    fn parses_version_parts() {
        let v = Version::parse("2:1.5.0-3");
        assert_eq!(
            v,
            Version {
                epoch: 2,
                pkgver: "1.5.0",
                pkgrel: Some("3")
            }
        );
        let v = Version::parse("1.5.0");
        assert_eq!(
            v,
            Version {
                epoch: 0,
                pkgver: "1.5.0",
                pkgrel: None
            }
        );
    }
}
