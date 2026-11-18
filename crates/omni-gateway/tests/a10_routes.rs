//! The A10 route inventory must not fall through to static/404 handling.
use hyper::Method;

#[test]
fn lifecycle_and_database_inventory_is_routed() {
    for (method, path) in [
        (Method::POST, "/api/database/import"),
        (
            Method::POST,
            "/api/database/snapshots/db_2026-11-01T00-00-00-000Z_manual.sqlite/restore",
        ),
        (Method::GET, "/api/lifecycle"),
        (Method::POST, "/api/lifecycle/restart"),
        (Method::POST, "/api/lifecycle/shutdown"),
        (Method::GET, "/api/database"),
        (Method::POST, "/api/database/vacuum"),
        (Method::DELETE, "/api/database/bodies"),
        (Method::GET, "/api/database/snapshots"),
        (Method::POST, "/api/database/snapshots"),
        (Method::PUT, "/api/database/retention"),
        (
            Method::GET,
            "/api/database/snapshots/db_2026-11-01T00-00-00-000Z_manual.sqlite/download",
        ),
        (
            Method::DELETE,
            "/api/database/snapshots/db_2026-11-01T00-00-00-000Z_manual.sqlite",
        ),
    ] {
        assert!(
            omni_gateway::api::route(&method, path).is_some(),
            "{method} {path}"
        );
    }
}
