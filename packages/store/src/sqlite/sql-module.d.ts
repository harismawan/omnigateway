/**
 * Ambient module declaration for `.sql` files imported with Bun's
 * `with { type: "text" }` import attribute (see db.ts). The installed
 * bun-types version declares this pattern for `*.txt`, `*.toml`, `*.yaml`,
 * `*.yml`, `*.jsonc`, `*.json5`, and `*.html`, but not `*.sql`.
 */
declare module "*.sql" {
  const contents: string;
  export default contents;
}
