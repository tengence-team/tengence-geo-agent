/**
 * channel-state / errors — stable codes for the single channel status entry
 * ============================================================================
 * E_INVALID_STATE        value is not in the vocabulary (this is how `blocked` got in)
 * E_INVALID_TRANSITION   the move is not in the table (e.g. published -> todo)
 * E_REASON_REQUIRED      deleted / review_failed / deleted->todo must explain themselves
 * E_NOT_FOUND            no channel_plan row matched
 * E_STATUS_BYPASS        something tried to write `status` without going through setState
 * ============================================================================
 */

class ChannelStateError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ChannelStateError';
    this.code = code;
    this.details = details || null;
  }
}

function invalidState(status, allowed) {
  return new ChannelStateError(
    'E_INVALID_STATE',
    `Invalid channel_plan status "${status}" (allowed: ${allowed.join(', ')})`,
    { status, allowed }
  );
}

function invalidTransition(from, to, allowed) {
  return new ChannelStateError(
    'E_INVALID_TRANSITION',
    `illegal status transition ${from} -> ${to}` + (allowed ? ` (from ${from}: ${allowed.join(', ')})` : ''),
    { from, to, allowed }
  );
}

function reasonRequired(from, to) {
  return new ChannelStateError(
    'E_REASON_REQUIRED',
    `status change ${from} -> ${to} requires a reason (it hides or revives content)`,
    { from, to }
  );
}

function notFound(id) {
  return new ChannelStateError('E_NOT_FOUND', `channel_plan row not found: id=${id}`, { id });
}

function statusBypass(where) {
  return new ChannelStateError(
    'E_STATUS_BYPASS',
    `channel_plan status may only be written through channelState.setState (attempt from ${where})`,
    { where }
  );
}

module.exports = { ChannelStateError, invalidState, invalidTransition, reasonRequired, notFound, statusBypass };
