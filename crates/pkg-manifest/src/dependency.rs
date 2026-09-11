//! Dependency rules in Arch syntax: `name`, `name>=1.2`, `name=1.2-1`,
//! `libfoo.so=3-64`, `libc.so.6(GLIBC_2.38)`.

use std::fmt;
use std::str::FromStr;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::vercmp::vercmp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VersionOp {
    Eq,
    Ge,
    Le,
    Gt,
    Lt,
}

impl VersionOp {
    fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Ge => ">=",
            Self::Le => "<=",
            Self::Gt => ">",
            Self::Lt => "<",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct VersionConstraint {
    pub op: VersionOp,
    pub version: String,
}

impl VersionConstraint {
    /// Returns whether `candidate` satisfies this constraint using Arch `vercmp`
    /// semantics.
    pub fn matches(&self, candidate: &str) -> bool {
        let ord = vercmp(candidate, &self.version);
        match self.op {
            VersionOp::Eq => ord.is_eq(),
            VersionOp::Ge => ord.is_ge(),
            VersionOp::Le => ord.is_le(),
            VersionOp::Gt => ord.is_gt(),
            VersionOp::Lt => ord.is_lt(),
        }
    }
}

/// A single dependency or capability.
///
/// The optional `symbol_version` captures glibc-style symbol version needs
/// (`libc.so.6(GLIBC_2.38)`) that come from the ELF `.gnu.version_r` section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct DependencyRule {
    pub name: String,
    pub constraint: Option<VersionConstraint>,
    pub symbol_version: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("dependency rule is empty")]
    Empty,
    #[error("dependency rule `{0}` has an operator but no version")]
    MissingVersion(String),
    #[error("dependency rule `{0}` has an unterminated symbol version")]
    UnterminatedSymbolVersion(String),
}

impl DependencyRule {
    pub fn unversioned(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            constraint: None,
            symbol_version: None,
        }
    }

    pub fn with_constraint(
        name: impl Into<String>,
        op: VersionOp,
        version: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            constraint: Some(VersionConstraint {
                op,
                version: version.into(),
            }),
            symbol_version: None,
        }
    }

    /// Whether a provided capability `name=version` satisfies this rule.
    ///
    /// * Names must match exactly.
    /// * Symbol versions are compared only when both sides carry one.
    /// * An unversioned rule is satisfied by any version; a versioned rule against an
    ///   unversioned provider is **not** satisfied (mirrors `libalpm` behaviour).
    pub fn satisfied_by(&self, provided: &DependencyRule) -> bool {
        if self.name != provided.name {
            return false;
        }
        if let (Some(need), Some(have)) = (&self.symbol_version, &provided.symbol_version) {
            if need != have {
                return false;
            }
        }
        match &self.constraint {
            None => true,
            Some(c) => match &provided.constraint {
                Some(VersionConstraint {
                    op: VersionOp::Eq,
                    version,
                }) => c.matches(version),
                _ => false,
            },
        }
    }
}

impl FromStr for DependencyRule {
    type Err = ParseError;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        // Longest operators first so `>=` is not read as `>` + `=1.0`.
        const OPS: [(&str, VersionOp); 5] = [
            (">=", VersionOp::Ge),
            ("<=", VersionOp::Le),
            ("=", VersionOp::Eq),
            (">", VersionOp::Gt),
            ("<", VersionOp::Lt),
        ];

        let s = input.trim();
        if s.is_empty() {
            return Err(ParseError::Empty);
        }

        // Split off `(SYMBOL_VERSION)` suffix first, e.g. `libc.so.6(GLIBC_2.38)`.
        let (s, symbol_version) = match s.find('(') {
            Some(open) => {
                let close = s.rfind(')').filter(|c| *c > open);
                let close =
                    close.ok_or_else(|| ParseError::UnterminatedSymbolVersion(input.to_owned()))?;
                (&s[..open], Some(s[open + 1..close].to_owned()))
            }
            None => (s, None),
        };

        for (token, op) in OPS {
            if let Some(idx) = s.find(token) {
                let name = s[..idx].to_owned();
                let version = s[idx + token.len()..].to_owned();
                if version.is_empty() || name.is_empty() {
                    return Err(ParseError::MissingVersion(input.to_owned()));
                }
                return Ok(Self {
                    name,
                    constraint: Some(VersionConstraint { op, version }),
                    symbol_version,
                });
            }
        }

        Ok(Self {
            name: s.to_owned(),
            constraint: None,
            symbol_version,
        })
    }
}

impl fmt::Display for DependencyRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name)?;
        if let Some(c) = &self.constraint {
            write!(f, "{}{}", c.op.as_str(), c.version)?;
        }
        if let Some(sv) = &self.symbol_version {
            write!(f, "({sv})")?;
        }
        Ok(())
    }
}

impl TryFrom<String> for DependencyRule {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<DependencyRule> for String {
    fn from(rule: DependencyRule) -> Self {
        rule.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> DependencyRule {
        s.parse().unwrap()
    }

    #[test]
    fn parses_plain_name() {
        assert_eq!(r("openssl"), DependencyRule::unversioned("openssl"));
    }

    #[test]
    fn parses_operators() {
        assert_eq!(
            r("python>=3.12"),
            DependencyRule::with_constraint("python", VersionOp::Ge, "3.12")
        );
        assert_eq!(
            r("foo<=2"),
            DependencyRule::with_constraint("foo", VersionOp::Le, "2")
        );
        assert_eq!(
            r("foo=1.0-1"),
            DependencyRule::with_constraint("foo", VersionOp::Eq, "1.0-1")
        );
        assert_eq!(
            r("foo>1"),
            DependencyRule::with_constraint("foo", VersionOp::Gt, "1")
        );
        assert_eq!(
            r("foo<1"),
            DependencyRule::with_constraint("foo", VersionOp::Lt, "1")
        );
    }

    #[test]
    fn parses_soname_provides() {
        let rule = r("libssl.so=3-64");
        assert_eq!(rule.name, "libssl.so");
        assert_eq!(rule.constraint.unwrap().version, "3-64");
    }

    #[test]
    fn parses_symbol_version() {
        let rule = r("libc.so.6(GLIBC_2.38)");
        assert_eq!(rule.name, "libc.so.6");
        assert_eq!(rule.symbol_version.as_deref(), Some("GLIBC_2.38"));
        assert!(rule.constraint.is_none());
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!("".parse::<DependencyRule>(), Err(ParseError::Empty));
        assert!(matches!(
            "foo>=".parse::<DependencyRule>(),
            Err(ParseError::MissingVersion(_))
        ));
        assert!(matches!(
            "libc.so.6(GLIBC".parse::<DependencyRule>(),
            Err(ParseError::UnterminatedSymbolVersion(_))
        ));
    }

    #[test]
    fn display_round_trips() {
        for s in [
            "openssl",
            "python>=3.12",
            "libssl.so=3-64",
            "libc.so.6(GLIBC_2.38)",
        ] {
            assert_eq!(r(s).to_string(), s);
        }
    }

    #[test]
    fn satisfaction_rules() {
        assert!(r("python>=3.12").satisfied_by(&r("python=3.13.1-1")));
        assert!(!r("python>=3.12").satisfied_by(&r("python=3.11-1")));
        assert!(r("python").satisfied_by(&r("python=3.11-1")));
        assert!(r("python").satisfied_by(&r("python")));
        assert!(!r("python>=3").satisfied_by(&r("python")));
        assert!(!r("python").satisfied_by(&r("ruby")));
        assert!(r("libc.so.6(GLIBC_2.38)").satisfied_by(&r("libc.so.6(GLIBC_2.38)")));
        assert!(!r("libc.so.6(GLIBC_2.38)").satisfied_by(&r("libc.so.6(GLIBC_2.37)")));
        assert!(r("libc.so.6(GLIBC_2.38)").satisfied_by(&r("libc.so.6")));
    }
}
