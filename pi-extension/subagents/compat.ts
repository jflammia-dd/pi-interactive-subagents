/**
 * Small pure helpers for pi API contracts that changed or tightened across
 * pi releases. They import nothing from pi, so unit tests exercise them
 * without loading the extension's agent files or a pi runtime.
 */
import { isAbsolute } from "node:path";

export type KeyHintFn = (keybinding: string, description: string) => string;

/**
 * Delivery options for `pi.sendUserMessage` from a slash command handler.
 * Commands run immediately, even mid-run. Without `deliverAs`, pi rejects a
 * message sent while a run is active and the message is dropped with an
 * extension error. While idle, no option is needed.
 */
export function userMessageDelivery(isIdle: boolean): { deliverAs: "followUp" } | undefined {
  return isIdle ? undefined : { deliverAs: "followUp" };
}

/**
 * Pick the keyHint formatter for a message renderer. Pi passes one in the
 * renderer options that reads the user's configured keybindings. An import of
 * `keyHint` from the package can resolve a second copy of the package that
 * does not see them, so the injected function wins and the import is only the
 * fallback.
 */
export function resolveKeyHint(
  options: { keyHint?: KeyHintFn } | undefined,
  fallback: KeyHintFn,
): KeyHintFn {
  return options?.keyHint ?? fallback;
}

/**
 * An extension specifier is safe to hand to a child pi with `-e` when it is a
 * built-in or an absolute file path. Package specifiers (`npm:`, `git:`) and
 * relative paths would make the child resolve or reinstall code at spawn time.
 */
export function isAcceptableExtensionSpecifier(spec: string): boolean {
  return spec.startsWith("builtin:") || isAbsolute(spec);
}
