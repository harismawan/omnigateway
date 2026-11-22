//! Codex browser authorization.
use crate::oauth::{AuthorizeStart, PendingFlow};

pub fn start(redirect: &str, verifier: &str, challenge: &str, state: &str) -> AuthorizeStart {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann"),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("state", state),
            ("originator", &super::profile::originator()),
            ("prompt", "login"),
        ])
        .finish();
    AuthorizeStart {
        authorize_url: format!("https://auth.openai.com/oauth/authorize?{query}"),
        pending: PendingFlow {
            verifier: verifier.into(),
            challenge: challenge.into(),
            state: state.into(),
            redirect_uri: redirect.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn browser_query_keeps_callback_and_pkce_binding() {
        let (verifier, challenge) = crate::oauth::pkce();
        let state = crate::oauth::random_state();
        let redirect = "http://localhost:1455/auth/callback";
        let start = super::start(redirect, &verifier, &challenge, &state);
        let url = url::Url::parse(&start.authorize_url).expect("authorize URL");
        let fields: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://auth.openai.com"
        );
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(fields.get("redirect_uri").expect("redirect"), redirect);
        assert_eq!(fields.get("state").expect("state"), &state);
        assert_eq!(
            fields.get("code_challenge").expect("challenge"),
            &crate::oauth::pkce_challenge(&start.pending.verifier)
        );
        assert_eq!(fields.get("code_challenge_method").expect("method"), "S256");
        assert_eq!(
            fields.get("scope").expect("scope"),
            "openid profile email offline_access"
        );
        assert_eq!(fields.get("prompt").expect("prompt"), "login");
        assert_eq!(start.pending.redirect_uri, redirect);
    }
}
