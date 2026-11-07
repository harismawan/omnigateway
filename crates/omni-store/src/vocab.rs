//! The string unions TS stores in TEXT columns and casts without checking.
//!
//! TS reads `breaker_state`, `auth_type`, `strategy` and `disabled_reason`
//! with a bare `as` cast, so a row holding a name this build does not know is
//! carried through as that string. `Other` keeps it rather than refusing the
//! whole snapshot; every consumer decides what an unknown name means for it.

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant,)+
            /// A stored name this build does not know, kept verbatim.
            Other(String),
        }

        impl $name {
            pub fn parse(s: &str) -> Self {
                match s {
                    $($text => Self::$variant,)+
                    other => Self::Other(other.to_owned()),
                }
            }

            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $text,)+
                    Self::Other(s) => s,
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <String as serde::Deserialize>::deserialize(d)?;
                Ok(Self::parse(&s))
            }
        }
    };
}

string_enum!(
    /// `AuthType`.
    AuthType { OAuth => "oauth", ApiKey => "apiKey" }
);

string_enum!(
    /// `BreakerState`.
    BreakerState { Closed => "closed", Open => "open", HalfOpen => "halfOpen" }
);

string_enum!(
    /// `Strategy`.
    Strategy {
        Score => "score",
        Priority => "priority",
        RoundRobin => "roundRobin",
        Weighted => "weighted",
    }
);

string_enum!(
    /// `DisabledReason`: why `enabled` is false.
    DisabledReason {
        TokenRejected => "tokenRejected",
        ExpiredNoRefresh => "expiredNoRefresh",
        Manual => "manual",
    }
);
