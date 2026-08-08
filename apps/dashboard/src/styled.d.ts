import "styled-components";
import type { AppTheme } from "./theme/tokens.ts";

declare module "styled-components" {
  // The theme is the token object verbatim; widening it would lose the literals.
  export interface DefaultTheme extends AppTheme {}
}
