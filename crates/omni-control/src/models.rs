//! Lossless operator projection; routing retains its separate validated reader.
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;

pub fn list(store: &SqliteStore) -> Result<Vec<JsValue>, String> {
    list_with(store, |e| e.to_string())
}

/// Operator-terminal projection; parser details must not enter gateway logs.
pub fn cli_list(store: &SqliteStore) -> Result<Vec<JsValue>, String> {
    let mut stmt = store
        .connection()
        .prepare("SELECT * FROM virtual_models ORDER BY id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let cell = |name| row.get_ref(name).map_err(|e| e.to_string());
        out.push(JsValue::Object(vec![
            (
                "id".encode_utf16().collect(),
                crate::cli_cell::Cell::read(cell("id")?).json(),
            ),
            (
                "targets".encode_utf16().collect(),
                crate::cli_cell::json(cell("targets")?)?,
            ),
            (
                "strategy".encode_utf16().collect(),
                crate::cli_cell::Cell::read(cell("strategy")?).json(),
            ),
            (
                "isAlias".encode_utf16().collect(),
                JsValue::Bool(matches!(
                    cell("is_alias")?,
                    rusqlite::types::ValueRef::Integer(1) | rusqlite::types::ValueRef::Real(1.0)
                )),
            ),
        ]));
    }
    Ok(out)
}

fn list_with(
    store: &SqliteStore,
    render: fn(omni_store::StoreError) -> String,
) -> Result<Vec<JsValue>, String> {
    omni_store::models::operator_rows(store.connection())
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, targets, strategy, alias)| {
            Ok(JsValue::Object(vec![
                (
                    "id".encode_utf16().collect(),
                    JsValue::from(&serde_json::json!(id)),
                ),
                (
                    "targets".encode_utf16().collect(),
                    crate::operator_json::parse(&targets).map_err(|detail| {
                        render(omni_store::StoreError::StoredJson {
                            table: "virtual_models",
                            column: "targets",
                            row_id: id.clone().unwrap_or_else(|| "null".into()),
                            detail: detail.into(),
                        })
                    })?,
                ),
                (
                    "strategy".encode_utf16().collect(),
                    JsValue::from(&serde_json::json!(strategy)),
                ),
                ("isAlias".encode_utf16().collect(), JsValue::Bool(alias)),
            ]))
        })
        .collect()
}
pub fn get(store: &SqliteStore, id: &str) -> Result<JsValue, String> {
    list(store)?
        .into_iter()
        .find(|m| {
            crate::settings_value::get(m, "id") == Some(&JsValue::from(&serde_json::json!(id)))
        })
        .ok_or_else(|| format!("MODEL_UNAVAILABLE: no virtual model \"{id}\""))
}

pub fn cli_get(store: &SqliteStore, id: &str) -> Result<JsValue, String> {
    cli_list(store)?
        .into_iter()
        .find(|m| {
            crate::settings_value::get(m, "id") == Some(&JsValue::from(&serde_json::json!(id)))
        })
        .ok_or_else(|| format!("MODEL_UNAVAILABLE: no virtual model \"{id}\""))
}

pub fn remove(store: &SqliteStore, id: &str) -> Result<(), String> {
    omni_store::models::remove(store.connection(), id).map_err(|e| e.to_string())
}

pub fn put(store: &SqliteStore, id: &str, input: &JsValue) -> Result<(), String> {
    put_with(store, id, input, |e| e.to_string(), false)
}

pub fn cli_put(store: &SqliteStore, id: &str, input: &JsValue) -> Result<(), String> {
    put_with(store, id, input, crate::cli_error::store, true)
}

fn put_with(
    store: &SqliteStore,
    id: &str,
    input: &JsValue,
    render: fn(omni_store::StoreError) -> String,
    terminal: bool,
) -> Result<(), String> {
    use crate::settings_value::get;
    let model = crate::model_schema::parse(input)?;
    let text = |s: &str| JsValue::String(s.encode_utf16().collect());
    if get(&model, "id") != Some(&text(id)) {
        return Err("BAD_REQUEST: model id in the path and body must match".into());
    }
    let credential_rows = if terminal {
        crate::credentials::cli_rows(store)?
    } else {
        crate::credentials::rows(store, None).map_err(|e| e.message)?
    };
    let credentials = credential_rows
        .into_iter()
        .map(|c| {
            let field = |k| get(&c, k).cloned().unwrap_or(JsValue::Null);
            (
                field("id"),
                field("provider"),
                field("label"),
                field("authType"),
                get(&c, "providerData").cloned().unwrap_or(JsValue::Null),
            )
        })
        .collect::<Vec<_>>();
    let Some(JsValue::Array(targets)) = get(&model, "targets") else {
        unreachable!()
    };
    if credentials
        .iter()
        .any(|(_, p, _, _, d)| p == &text("custom") && matches!(d, JsValue::Null))
    {
        return Err(
            "null is not an object (evaluating 'credential.providerData.endpointId')".into(),
        );
    }
    for t in targets {
        if get(t, "provider") == Some(&text("custom"))
            && !credentials.iter().any(|(_, p, _, _, d)| {
                p == &text("custom") && get(d, "endpointId") == get(t, "endpointId")
            })
        {
            return Err(format!(
                "BAD_REQUEST: custom endpoint \"{}\" has no credential",
                crate::operator_json::string(get(t, "endpointId").expect("schema"))?
            ));
        }
    }
    let existing = if terminal {
        cli_list(store)?
    } else {
        list_with(store, render)?
    };
    let stored = existing.iter().find(|m| get(m, "id") == Some(&text(id)));
    let old = stored.and_then(|m| get(m, "targets"));
    let pairs=match old {
        None|Some(JsValue::Null)=> &[][..],
        Some(JsValue::Array(a))=>a.as_slice(),
        Some(_)=> return Err("(stored?.targets ?? []).map is not a function. (In '(stored?.targets ?? []).map(pairOf)', '(stored?.targets ?? []).map' is undefined)".into()),
    };
    let pair = |v: &JsValue| -> Result<Vec<u16>, String> {
        if matches!(v, JsValue::Null) {
            return Err("null is not an object (evaluating 'target.provider')".into());
        }
        let value = |k| {
            get(v, k).map_or_else(
                || Ok("undefined".encode_utf16().collect::<Vec<_>>()),
                crate::operator_json::coerce_units,
            )
        };
        let mut pair = value("provider")?;
        pair.push(0);
        pair.extend(value("model")?);
        Ok(pair)
    };
    let pairs = pairs.iter().map(pair).collect::<Result<Vec<_>, _>>()?;
    for t in targets {
        let provider = crate::operator_json::string(get(t, "provider").expect("schema"))?;
        let model_id = crate::operator_json::string(get(t, "model").expect("schema"))?;
        let mut pin = None;
        if get(t, "credentialId").is_some() {
            for account in &credentials {
                let (id, p, _, _, d) = account;
                if p != &text(&provider) {
                    continue;
                }
                if matches!(d, JsValue::Null) {
                    return Err(
                        "null is not an object (evaluating 'account.providerData.endpointId')"
                            .into(),
                    );
                }
                if get(t, "endpointId") == get(d, "endpointId")
                    && get(t, "credentialId") == Some(id)
                {
                    pin = Some(account);
                    break;
                }
            }
        }
        if pin.is_none() && pairs.contains(&pair(t)?) {
            continue;
        }
        let mut have = Vec::new();
        for c in credentials.iter().filter(|c| {
            if let Some(pin) = pin {
                std::ptr::eq(*c, pin)
            } else {
                c.1 == text(&provider)
            }
        }) {
            if !have.contains(&&c.3) {
                have.push(&c.3);
            }
        }
        if have.is_empty() {
            continue;
        }
        let reach = crate::catalog::model_auths(&provider, &model_id);
        if reach.iter().any(|a| have.contains(&&text(a))) {
            continue;
        }
        let phrase = |a: &[&JsValue]| {
            a.iter()
                .map(|a| {
                    if **a == text("oauth") {
                        "OAuth"
                    } else if **a == text("apiKey") {
                        "API key"
                    } else {
                        ""
                    }
                })
                .collect::<Vec<_>>()
                .join(" or ")
        };
        let (holds, fix) = if let Some(c) = pin {
            (
                format!(
                    "this target is pinned to \"{}\", which is {}",
                    crate::cli_cell::scalar_string(&c.2),
                    phrase(&have)
                ),
                "pin it to the other kind, or pick a model this account can reach",
            )
        } else {
            (
                format!("every {provider} credential here is {}", phrase(&have)),
                "connect the other kind, or pick a model this one can reach",
            )
        };
        return Err(format!(
            "BAD_REQUEST: {provider} serves \"{model_id}\" to {} credentials only, and {holds} — {fix}",
            phrase(
                &reach
                    .iter()
                    .map(|a| text(a))
                    .collect::<Vec<_>>()
                    .iter()
                    .collect::<Vec<_>>()
            )
        ));
    }
    let strategy = crate::operator_json::string(get(&model, "strategy").expect("schema"))?;
    let targets = omni_ir::jsjson::stringify(get(&model, "targets").expect("schema"))
        .expect("validated JSON");
    omni_store::models::put(
        store.connection(),
        id,
        &targets,
        &strategy,
        get(&model, "isAlias") == Some(&JsValue::Bool(true)),
    )
    .map_err(|e| e.to_string())
}
