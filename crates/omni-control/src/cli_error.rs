//! Explicit operator-terminal rendering. Never use this for internal logs.
pub fn store(error: omni_store::StoreError) -> String {
    match error {
        omni_store::StoreError::StoredJson { detail, .. } => detail.into_wire_detail(),
        error => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn terminal_reads_parser_detail() {
        let detail = "JSON Parse error: Unexpected identifier \"broken\"";
        assert_eq!(
            super::store(omni_store::StoreError::StoredJson {
                table: "virtual_models",
                column: "targets",
                row_id: "v".into(),
                detail: detail.to_owned().into(),
            }),
            detail
        );
    }
}
