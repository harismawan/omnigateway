//! The message Bun's `JSON.parse` throws for a body that is not JSON.
//!
//! TS answers such a body with `500 INTERNAL` and the `SyntaxError`'s own
//! message (`request.json()` → `asGatewayError` → `describeError`), so the
//! client sees JavaScriptCore's wording. This is a port of the error paths of
//! JSC's `LiteralParser` in StrictJSON mode (`parseRecursively`,
//! `parsePrimitiveValue`, the lexer's `lexString`/`lexNumber`/`lexIdentifier`
//! and `getErrorMessage`), run only after `serde_json` has refused a body.
//!
//! Iterative, with an explicit stack: an invalid body can be as deep as a
//! valid one.
//!
//! Known difference: an unrecognized astral character is printed whole,
//! where JSC prints its first UTF-16 code unit (a lone surrogate).

/// The full `SyntaxError.message`, or `None` where `JSON.parse` would accept
/// the text (a number outside the double range, a lone surrogate escape).
pub fn parse_error(text: &str) -> Option<String> {
    if text.is_empty() {
        // `Request.json()` on an empty body throws before the parser runs.
        return Some("Unexpected end of JSON input".to_owned());
    }
    let wide = text.chars().any(|c| u32::from(c) > 0xff);
    let mut p = Parser {
        lexer: Lexer {
            s: text.as_bytes(),
            text,
            pos: 0,
            wide,
            error: None,
        },
        parse_error: None,
    };
    let ok = p.run();
    if ok {
        return None;
    }
    let inner = p
        .lexer
        .error
        .or(p.parse_error)
        .unwrap_or_else(|| "Unable to parse JSON string".to_owned());
    Some(format!("JSON Parse error: {inner}"))
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Colon,
    Comma,
    Dot,
    LParen,
    RParen,
    Semi,
    Assign,
    Str,
    Number,
    True,
    False,
    Null,
    Ident(String),
    End,
    Error,
}

struct Lexer<'a> {
    s: &'a [u8],
    text: &'a str,
    pos: usize,
    wide: bool,
    /// `m_lexErrorMessage`: the first lex error wins over any parse error.
    error: Option<String>,
}

impl Lexer<'_> {
    fn set_error(&mut self, m: impl Into<String>) {
        // JSC overwrites; the parser stops at the first error token anyway,
        // except where a later token is lexed after a recoverable one.
        self.error = Some(m.into());
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    fn char_at(&self, i: usize) -> char {
        self.text[i..].chars().next().unwrap_or('\0')
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn next(&mut self) -> Tok {
        self.skip_ws();
        let Some(b) = self.peek() else {
            return Tok::End;
        };
        let c = self.char_at(self.pos);
        if u32::from(c) <= 0xff {
            match b {
                b'"' => return self.lex_string(),
                b'\'' => {
                    self.set_error("Single quotes (') are not allowed in JSON");
                    return Tok::Error;
                }
                b'$' | b'_' | b'A'..=b'Z' | b'a'..=b'z' => {
                    for (word, tok) in [
                        ("true", Tok::True),
                        ("false", Tok::False),
                        ("null", Tok::Null),
                    ] {
                        if self.s[self.pos..].starts_with(word.as_bytes()) {
                            self.pos += word.len();
                            return tok;
                        }
                    }
                    return self.lex_identifier();
                }
                b'-' | b'0'..=b'9' => return self.lex_number(),
                b'[' => return self.punct(Tok::LBracket),
                b']' => return self.punct(Tok::RBracket),
                b'{' => return self.punct(Tok::LBrace),
                b'}' => return self.punct(Tok::RBrace),
                b':' => return self.punct(Tok::Colon),
                b',' => return self.punct(Tok::Comma),
                b'.' => return self.punct(Tok::Dot),
                b'(' => return self.punct(Tok::LParen),
                b')' => return self.punct(Tok::RParen),
                b';' => return self.punct(Tok::Semi),
                b'=' => return self.punct(Tok::Assign),
                _ => {}
            }
        }
        self.set_error(format!("Unrecognized token '{c}'"));
        Tok::Error
    }

    fn punct(&mut self, t: Tok) -> Tok {
        self.pos += 1;
        t
    }

    fn ident_char(&self, c: char) -> bool {
        c.is_ascii_alphanumeric()
            || c == '_'
            || c == '$'
            || (self.wide && (c == '\u{200c}' || c == '\u{200d}'))
    }

    fn lex_identifier(&mut self) -> Tok {
        let start = self.pos;
        while self.pos < self.s.len() {
            let c = self.char_at(self.pos);
            if !self.ident_char(c) {
                break;
            }
            self.pos += c.len_utf8();
        }
        Tok::Ident(self.text[start..self.pos].to_owned())
    }

    fn lex_string(&mut self) -> Tok {
        self.pos += 1;
        loop {
            let Some(b) = self.peek() else {
                self.set_error("Unterminated string");
                return Tok::Error;
            };
            match b {
                b'"' => {
                    self.pos += 1;
                    return Tok::Str;
                }
                b'\\' => {
                    self.pos += 1;
                    let Some(e) = self.peek() else {
                        self.set_error("Unterminated string");
                        return Tok::Error;
                    };
                    match e {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => self.pos += 1,
                        b'u' => {
                            // `(m_end - m_ptr) < 5`, counted in code units.
                            let rest: Vec<char> = self.text[self.pos..].chars().take(5).collect();
                            if rest.len() < 5 {
                                self.set_error("\\u must be followed by 4 hex digits");
                                return Tok::Error;
                            }
                            if !rest[1..].iter().all(char::is_ascii_hexdigit) {
                                let five: String = rest.iter().collect();
                                self.set_error(format!(
                                    "\"\\{five}\" is not a valid unicode escape"
                                ));
                                return Tok::Error;
                            }
                            self.pos += 5;
                        }
                        _ => {
                            let c = self.char_at(self.pos);
                            self.set_error(format!("Invalid escape character {c}"));
                            return Tok::Error;
                        }
                    }
                }
                0..=0x1f => {
                    self.set_error("Unterminated string");
                    return Tok::Error;
                }
                _ => self.pos += 1,
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos - start
    }

    /// `-?(0|[1-9][0-9]*)`, then the longest complete `.digits` and
    /// `e[+-]?digits` it can take. A `.` with no digit after it is the one
    /// failure (`Invalid digits after decimal point`); an incomplete exponent
    /// is simply not part of the number, as WTF's `parseJSONDouble` reads it.
    fn lex_number(&mut self) -> Tok {
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => {
                self.set_error("Invalid number");
                return Tok::Error;
            }
        }
        if self.peek() == Some(b'.') {
            if !matches!(self.s.get(self.pos + 1), Some(b'0'..=b'9')) {
                self.set_error("Invalid digits after decimal point");
                return Tok::Error;
            }
            self.pos += 1;
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let save = self.pos;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                self.pos = save;
            }
        }
        Tok::Number
    }
}

enum Frame {
    Array,
    Object { after_comma: bool },
}

struct Parser<'a> {
    lexer: Lexer<'a>,
    parse_error: Option<String>,
}

impl Parser<'_> {
    fn fail(&mut self, m: &str) -> bool {
        self.parse_error = Some(m.to_owned());
        false
    }

    /// `parsePrimitiveValue`'s refusal for a token that cannot start a value.
    fn not_a_value(&mut self, t: &Tok) -> bool {
        let m = match t {
            Tok::RBracket => "Unexpected token ']'".to_owned(),
            Tok::RBrace => "Unexpected token '}'".to_owned(),
            Tok::Ident(name) => {
                let chars: Vec<char> = name.chars().collect();
                let shown: String = chars.iter().take(200).collect();
                let more = if chars.len() > 200 { "..." } else { "" };
                format!("Unexpected identifier \"{shown}{more}\"")
            }
            Tok::Colon => "Unexpected token ':'".to_owned(),
            Tok::LParen => "Unexpected token '('".to_owned(),
            Tok::RParen => "Unexpected token ')'".to_owned(),
            Tok::Comma => "Unexpected token ','".to_owned(),
            Tok::Dot => "Unexpected token '.'".to_owned(),
            Tok::Assign => "Unexpected token '='".to_owned(),
            Tok::Semi => "Unexpected token ';'".to_owned(),
            Tok::End => "Unexpected EOF".to_owned(),
            _ => "Could not parse value expression".to_owned(),
        };
        self.parse_error = Some(m);
        false
    }

    /// Whether the whole text parses.
    fn run(&mut self) -> bool {
        let mut stack: Vec<Frame> = Vec::new();
        let mut tok = self.lexer.next();
        // `value` is true while `tok` should start a value.
        'value: loop {
            match tok {
                Tok::LBracket => {
                    tok = self.lexer.next();
                    if tok == Tok::RBracket {
                        tok = self.lexer.next();
                    } else {
                        stack.push(Frame::Array);
                        continue 'value;
                    }
                }
                Tok::LBrace => {
                    stack.push(Frame::Object { after_comma: false });
                    // Object: read a key (or the closing brace).
                    match self.object_key(&mut stack) {
                        KeyStep::Value(t) => {
                            tok = t;
                            continue 'value;
                        }
                        KeyStep::Closed(t) => tok = t,
                        KeyStep::Failed => return false,
                    }
                }
                Tok::Str | Tok::Number | Tok::True | Tok::False | Tok::Null => {
                    tok = self.lexer.next();
                }
                other => return self.not_a_value(&other),
            }
            // A value just ended; `tok` is the token after it.
            loop {
                match stack.last_mut() {
                    None => return tok == Tok::End,
                    Some(Frame::Array) => match tok {
                        Tok::Comma => {
                            tok = self.lexer.next();
                            if tok == Tok::RBracket {
                                return self
                                    .fail("Unexpected comma at the end of array expression");
                            }
                            continue 'value;
                        }
                        Tok::RBracket => {
                            stack.pop();
                            tok = self.lexer.next();
                        }
                        _ => return self.fail("Expected ']'"),
                    },
                    Some(Frame::Object { after_comma }) => match tok {
                        Tok::Comma => {
                            *after_comma = true;
                            match self.object_key(&mut stack) {
                                KeyStep::Value(t) => {
                                    tok = t;
                                    continue 'value;
                                }
                                KeyStep::Closed(t) => tok = t,
                                KeyStep::Failed => return false,
                            }
                        }
                        Tok::RBrace => {
                            stack.pop();
                            tok = self.lexer.next();
                        }
                        _ => return self.fail("Expected '}'"),
                    },
                }
            }
        }
    }

    /// Reads `"key" :` in the object on top of the stack, then the first token
    /// of its value; or the closing brace of an empty object.
    fn object_key(&mut self, stack: &mut Vec<Frame>) -> KeyStep {
        let after_comma = matches!(stack.last(), Some(Frame::Object { after_comma: true }));
        let t = self.lexer.next();
        if t != Tok::Str {
            if after_comma {
                self.fail("Property name must be a string literal");
                return KeyStep::Failed;
            }
            if t != Tok::RBrace {
                self.fail("Expected '}'");
                return KeyStep::Failed;
            }
            stack.pop();
            return KeyStep::Closed(self.lexer.next());
        }
        if self.lexer.peek() == Some(b':') {
            self.lexer.pos += 1;
        } else if self.lexer.next() != Tok::Colon {
            self.fail("Expected ':' before value in object property definition");
            return KeyStep::Failed;
        }
        KeyStep::Value(self.lexer.next())
    }
}

enum KeyStep {
    /// The first token of the property's value.
    Value(Tok),
    /// The object was empty and closed; the token after it.
    Closed(Tok),
    Failed,
}

#[cfg(test)]
mod tests {
    use super::parse_error;

    /// Every message measured against Bun 1.4.4's `JSON.parse` (and
    /// `Request.json()` for the empty body).
    #[test]
    fn messages_match_bun() {
        let cases: &[(&str, Option<&str>)] = &[
            ("", Some("Unexpected end of JSON input")),
            ("{bad", Some("JSON Parse error: Expected '}'")),
            (
                "nope",
                Some("JSON Parse error: Unexpected identifier \"nope\""),
            ),
            (
                "{\"a\":1,}",
                Some("JSON Parse error: Property name must be a string literal"),
            ),
            ("[1,2", Some("JSON Parse error: Expected ']'")),
            ("{\"a\":\"x", Some("JSON Parse error: Unterminated string")),
            ("1e400", None),
            (" ", Some("JSON Parse error: Unexpected EOF")),
            ("{}x", Some("JSON Parse error: Unable to parse JSON string")),
            ("{", Some("JSON Parse error: Expected '}'")),
            ("[", Some("JSON Parse error: Unexpected EOF")),
            (
                "{\"a\"",
                Some("JSON Parse error: Expected ':' before value in object property definition"),
            ),
            ("{\"a\":", Some("JSON Parse error: Unexpected EOF")),
            (
                "{\"a\" 1}",
                Some("JSON Parse error: Expected ':' before value in object property definition"),
            ),
            ("[1 2]", Some("JSON Parse error: Expected ']'")),
            (
                "tru",
                Some("JSON Parse error: Unexpected identifier \"tru\""),
            ),
            (
                "true1",
                Some("JSON Parse error: Unable to parse JSON string"),
            ),
            ("01", Some("JSON Parse error: Unable to parse JSON string")),
            (
                "1.",
                Some("JSON Parse error: Invalid digits after decimal point"),
            ),
            ("-", Some("JSON Parse error: Invalid number")),
            (
                "\"\\x\"",
                Some("JSON Parse error: Invalid escape character x"),
            ),
            ("\"a\nb\"", Some("JSON Parse error: Unterminated string")),
            (
                "{'a':1}",
                Some("JSON Parse error: Single quotes (') are not allowed in JSON"),
            ),
            ("[,]", Some("JSON Parse error: Unexpected token ','")),
            ("{,}", Some("JSON Parse error: Expected '}'")),
            (
                "[1,]",
                Some("JSON Parse error: Unexpected comma at the end of array expression"),
            ),
            (
                "\u{e9}",
                Some("JSON Parse error: Unrecognized token '\u{e9}'"),
            ),
            (
                "{\"a\":1}}",
                Some("JSON Parse error: Unable to parse JSON string"),
            ),
            ("[]]", Some("JSON Parse error: Unable to parse JSON string")),
            ("1 2", Some("JSON Parse error: Unable to parse JSON string")),
            (
                "\"\\u12\"",
                Some("JSON Parse error: \\u must be followed by 4 hex digits"),
            ),
            (
                "{\"a\":[1,}",
                Some("JSON Parse error: Unexpected token '}'"),
            ),
            (
                "{\"a\":{\"b\":1,}}",
                Some("JSON Parse error: Property name must be a string literal"),
            ),
            ("1e", Some("JSON Parse error: Unable to parse JSON string")),
            ("{\"a\":-}", Some("JSON Parse error: Invalid number")),
            ("{\"a\":.5}", Some("JSON Parse error: Unexpected token '.'")),
            ("{a:1}", Some("JSON Parse error: Expected '}'")),
            ("\t", Some("JSON Parse error: Unexpected EOF")),
            ("[true false]", Some("JSON Parse error: Expected ']'")),
            (
                "NaN",
                Some("JSON Parse error: Unexpected identifier \"NaN\""),
            ),
            ("-Infinity", Some("JSON Parse error: Invalid number")),
            (
                "{\"a\":1,\"b\":}",
                Some("JSON Parse error: Unexpected token '}'"),
            ),
            ("+1", Some("JSON Parse error: Unrecognized token '+'")),
            ("[01]", Some("JSON Parse error: Expected ']'")),
            (
                "[1.e5]",
                Some("JSON Parse error: Invalid digits after decimal point"),
            ),
            ("[\"\u{1}\"]", Some("JSON Parse error: Unterminated string")),
            ("1e+", Some("JSON Parse error: Unable to parse JSON string")),
            ("[1.5e]", Some("JSON Parse error: Expected ']'")),
            ("{\"a\":1.5E-}", Some("JSON Parse error: Expected '}'")),
            ("[-]", Some("JSON Parse error: Invalid number")),
            ("[0x1]", Some("JSON Parse error: Expected ']'")),
            ("[1] +", Some("JSON Parse error: Unrecognized token '+'")),
            ("[1 +]", Some("JSON Parse error: Unrecognized token '+'")),
            (
                "{\"a\":1 +}",
                Some("JSON Parse error: Unrecognized token '+'"),
            ),
            (
                "[\"a\" \\]",
                Some("JSON Parse error: Unrecognized token '\\'"),
            ),
            ("[-01]", Some("JSON Parse error: Expected ']'")),
            ("[2147483648]", None),
            (
                "{\"\\x\":1}",
                Some("JSON Parse error: Invalid escape character x"),
            ),
            (
                "{\"a\":1,\"a\"}",
                Some("JSON Parse error: Expected ':' before value in object property definition"),
            ),
            ("{\n}", None),
            (
                "[1,\n]",
                Some("JSON Parse error: Unexpected comma at the end of array expression"),
            ),
            (
                "\u{a0}[]",
                Some("JSON Parse error: Unrecognized token '\u{a0}'"),
            ),
            (
                "{\"a\" : 1 , }",
                Some("JSON Parse error: Property name must be a string literal"),
            ),
            ("[truex]", Some("JSON Parse error: Expected ']'")),
            ("{\"a\":nullx}", Some("JSON Parse error: Expected '}'")),
            ("[-0.0e-0]", None),
            ("  [1]  ", None),
            ("[\"\u{4e2d}\" x]", Some("JSON Parse error: Expected ']'")),
            (
                "\u{4e2d}",
                Some("JSON Parse error: Unrecognized token '\u{4e2d}'"),
            ),
            ("\"\u{4e2d}", Some("JSON Parse error: Unterminated string")),
            (
                "[1,\"\u{4e2d}\",tru]",
                Some("JSON Parse error: Unexpected identifier \"tru\""),
            ),
        ];
        for (input, want) in cases {
            assert_eq!(parse_error(input).as_deref(), *want, "input {input:?}");
        }
        let long = format!("[{}]", "a".repeat(300));
        assert_eq!(
            parse_error(&long),
            Some(format!(
                "JSON Parse error: Unexpected identifier \"{}...\"",
                "a".repeat(200)
            ))
        );
    }

    #[test]
    fn a_deep_invalid_body_does_not_recurse() {
        let deep = "[".repeat(200_000);
        assert_eq!(
            parse_error(&deep).as_deref(),
            Some("JSON Parse error: Unexpected EOF")
        );
    }
}
