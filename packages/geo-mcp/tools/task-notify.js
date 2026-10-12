'use strict';
/**
 * Task change publisher (tools/task-notify.js) — MCP 2026-07-28 S7, 方案 A.
 * ============================================================================
 * The simplest possible bridge to the SDK's standard server→client change
 * notification channel. It does NOT build any bus of its own: it merely holds a
 * reference to the transport's `handler.notify` (the SDK's built-in
 * `InMemoryServerEventBus` + listenRouter) and, on a task reaching a terminal
 * state, publishes `notifications/resources/updated` for the task's resource URI
 * (`geo://task/<taskId>`). Clients that subscribed to that URI via
 * `subscriptions/listen { resourceSubscriptions: [...] }` receive the change
 * notification and then fetch the terminal state via `tasks/get` (no blind
 * polling).
 *
 * Scope: HTTP transport (createMcpHandler) exposes handler.notify and fully
 * supports this. The stdio transport (serveStdio) does not expose a notifier, so
 * stdio clients fall back to `tasks/get` polling (S6).
 */

let notifier = null;

/** Adopt the transport's notifier (e.g. createMcpHandler(factory).notify). */
function setNotifier(n) {
  notifier = n || null;
}

/** Publish a change notification for a task's resource URI (no-op when no notifier). */
function publishTask(taskId) {
  if (!notifier || !taskId) return;
  try {
    notifier.resourceUpdated(`geo://task/${taskId}`);
  } catch (e) {
    // The SDK's bus publish is a no-op when no subscription is open; a failure
    // here must never break the task lifecycle.
  }
}

module.exports = { setNotifier, publishTask };
