//! Lossless operator projection; routing retains its separate validated reader.
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;

pub fn list(store: &SqliteStore) -> Result<Vec<JsValue>, String> {
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
                    crate::operator_json::parse(&targets)?,
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

pub fn remove(store: &SqliteStore, id: &str) -> Result<(), String> {
    omni_store::models::remove(store.connection(), id).map_err(|e| e.to_string())
}

pub fn put(store: &SqliteStore, id: &str, input: &JsValue) -> Result<(), String> {
    use crate::settings_value::get;
    let model = crate::model_schema::parse(input)?;
    let text = |s: &str| JsValue::String(s.encode_utf16().collect());
    if get(&model, "id") != Some(&text(id)) {
        return Err("BAD_REQUEST: model id in the path and body must match".into());
    }
    let credentials = omni_store::models::operator_credentials(store.connection())
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, p, l, a, d)| Ok((id, p, l, a, crate::operator_json::parse(&d)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let Some(JsValue::Array(targets)) = get(&model, "targets") else {
        unreachable!()
    };
    if credentials
        .iter()
        .any(|(_, p, _, _, d)| p == "custom" && matches!(d, JsValue::Null))
    {
        return Err(
            "null is not an object (evaluating 'credential.providerData.endpointId')".into(),
        );
    }
    for t in targets {
        if get(t, "provider") == Some(&text("custom"))
            && !credentials.iter().any(|(_, p, _, _, d)| {
                p == "custom" && get(d, "endpointId") == get(t, "endpointId")
            })
        {
            return Err(format!(
                "BAD_REQUEST: custom endpoint \"{}\" has no credential",
                crate::operator_json::string(get(t, "endpointId").expect("schema"))?
            ));
        }
    }
    let existing = list(store)?;
    let stored = existing.iter().find(|m| get(m, "id") == Some(&text(id)));
    let old = stored.and_then(|m| get(m, "targets"));
    let pairs=match old {
        None|Some(JsValue::Null)=> &[][..],
        Some(JsValue::Array(a))=>a.as_slice(),
        Some(_)=> return Err("(stored?.targets ?? []).map is not a function. (In '(stored?.targets ?? []).map(pairOf)', '(stored?.targets ?? []).map' is undefined)".into()),
    };
    let pair = |v: &JsValue| -> Result<String, String> {
        if matches!(v, JsValue::Null) {
            return Err("null is not an object (evaluating 'target.provider')".into());
        }
        let value = |k| get(v, k).map_or(Ok("undefined".into()), crate::operator_json::string);
        Ok(format!("{}\0{}", value("provider")?, value("model")?))
    };
    let pairs = pairs.iter().map(pair).collect::<Result<Vec<_>, _>>()?;
    for t in targets {
        let provider = crate::operator_json::string(get(t, "provider").expect("schema"))?;
        let model_id = crate::operator_json::string(get(t, "model").expect("schema"))?;
        let mut pin = None;
        if get(t, "credentialId").is_some() {
            for account in &credentials {
                let (id, p, _, _, d) = account;
                if p != &provider {
                    continue;
                }
                if matches!(d, JsValue::Null) {
                    return Err(
                        "null is not an object (evaluating 'account.providerData.endpointId')"
                            .into(),
                    );
                }
                if get(t, "endpointId") == get(d, "endpointId")
                    && get(t, "credentialId") == Some(&text(id))
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
                c.1 == provider
            }
        }) {
            if !have.contains(&c.3.as_str()) {
                have.push(c.3.as_str());
            }
        }
        if have.is_empty() {
            continue;
        }
        let reach = model_auths(&provider, &model_id);
        if reach.iter().any(|a| have.contains(a)) {
            continue;
        }
        let phrase = |a: &[&str]| {
            a.iter()
                .map(|a| match *a {
                    "oauth" => "OAuth",
                    "apiKey" => "API key",
                    _ => "",
                })
                .collect::<Vec<_>>()
                .join(" or ")
        };
        let (holds, fix) = if let Some(c) = pin {
            (
                format!(
                    "this target is pinned to \"{}\", which is {}",
                    c.2,
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
            phrase(reach)
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

fn model_auths(provider: &str, model: &str) -> &'static [&'static str] {
    match provider {
        "qoder" | "antigravity" => &["oauth"],
        "custom" => &["apiKey"],
        "kilo"
            if matches!(
                model,
                "nvidia/nemotron-3-ultra-550b-a55b:free"
                    | "nvidia/nemotron-3.5-lightning:free"
                    | "dots-studio/dots-3-note-preview:free"
                    | "cohere/north-mini-code:free"
                    | "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
                    | "stepfun/step-3.7-flash:free"
                    | "nvidia/nemotron-3-super-120b-a12b:free"
                    | "tencent/hy3:free"
                    | "poolside/laguna-s-2.1:free"
                    | "poolside/laguna-xs-2.1:free"
                    | "liquid/lfm-2.5-2.6b:free"
                    | "nvidia/nemotron-3.5-content-safety:free"
                    | "kilo-auto/frontier"
                    | "kilo-auto/balanced"
                    | "kilo-auto/efficient"
                    | "kilo-auto/small"
                    | "kilo-auto/free"
            ) =>
        {
            &["apiKey"]
        }
        _ => &["oauth", "apiKey"],
    }
}
