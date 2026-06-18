/**
 * Daemon protocol types — the HTTP/SSE port of pi's `rpc-types.ts`, trimmed to the
 * verbs steward's `SessionHost` actually exposes.
 *
 * Commands arrive as a JSON body on `POST /control`; the response is that request's
 * JSON body. Events stream out of `GET /events` as SSE — a curated subset of the
 * harness's event surface (the `AgentEvent` stream plus queue/model/thinking
 * updates), never the internal own-events.
 */

import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	ModelUpdateEvent,
	QueueUpdateEvent,
	ThinkingLevel,
	ThinkingLevelUpdateEvent,
} from "@opsyhq/agent";

// ============================================================================
// Commands (POST /control body)
// ============================================================================

export type DaemonCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "wait_for_idle" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "reload" }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" }

	// Model / thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_model"; provider: string; modelId: string };

export type DaemonCommandType = DaemonCommand["type"];

// ============================================================================
// Responses (POST /control response body)
// ============================================================================

/**
 * pi's `RpcResponse` shape, collapsed to a single generic success arm (the daemon's
 * `data` is the verb-specific payload from the command → method mapping) plus the
 * shared error arm any command can land on.
 */
export type DaemonResponse =
	| { id?: string; type: "response"; command: DaemonCommandType; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Session state (get_state / hello snapshot)
// ============================================================================

/** Only the fields steward's `SessionHost` actually surfaces (see the plan's snapshot mapping). */
export interface DaemonSessionState {
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	messageCount: number;
}

// ============================================================================
// Events (GET /events SSE) — the curated forwarded union
// ============================================================================

/** The harness events forwarded to attach clients. Internal own-events are dropped. */
export type DaemonEvent = AgentEvent | QueueUpdateEvent | ModelUpdateEvent | ThinkingLevelUpdateEvent;

/**
 * Runtime allowlist of forwarded event `type` strings — the broadcaster filter. Mirrors
 * the `DaemonEvent` union: the full `AgentEvent` lifecycle plus the three update events.
 * Anything not in this set (save_point, settled, abort, session_*, tools_update,
 * resources_update, before_*, after_provider_response, …) stays internal to the daemon.
 */
export const FORWARDED_EVENT_TYPES: ReadonlySet<DaemonEvent["type"]> = new Set([
	// AgentEvent lifecycle
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	// Curated own-events
	"queue_update",
	"model_update",
	"thinking_level_update",
]);
