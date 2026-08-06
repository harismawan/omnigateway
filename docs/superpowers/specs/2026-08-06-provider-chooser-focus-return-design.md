# Provider chooser focus-return design

## Scope

Fix focus return when page-level **Connect provider** chooser closes without selection. This includes Cancel and Escape only. Provider-specific **Add account** buttons retain their existing direct `addProvider` behavior and focus handling.

## Design

`CredentialsScreen` owns persistent header trigger and chooser state. Store header **Connect provider** button in an explicit React ref.

Chooser content receives an `onCloseAutoFocus` callback. When no provider was selected, callback prevents Radix's implicit autofocus restoration and focuses header trigger through explicit ref. When provider selection starts `ConnectDialog`, callback still prevents chooser restoration so focus remains in newly opened provider connection dialog.

No changes to `ConnectDialog` or provider-specific `ProviderGroup` add-account flow.

## Tests

Extend credentials feature tests:

1. Open chooser from header, select Cancel, assert chooser closes and header **Connect provider** button owns focus.
2. Open chooser from header, press Escape, assert chooser closes and header **Connect provider** button owns focus.
3. Preserve existing selection assertion: selecting provider closes chooser and transfers focus into `ConnectDialog` rather than header trigger.

## Acceptance criteria

- Cancel returns focus to persistent header **Connect provider** button.
- Escape returns focus to persistent header **Connect provider** button.
- Selecting provider preserves `ConnectDialog` focus behavior.
- Provider-specific Add account flow remains unchanged.
