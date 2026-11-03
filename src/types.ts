export type AssistantState = "disconnected" | "connecting" | "listening" | "speaking";

export interface ToolCallPayload {
  name: string;
  args: any;
  id: string;
}

export interface ToolResponsePayload {
  name: string;
  response: {
    output: any;
  };
  id: string;
}

export interface StatusUpdate {
  type: "status";
  state: "connecting" | "connected" | "disconnected" | "error";
  message?: string;
  reason?: string;
}

export interface AudioUpdate {
  type: "audio";
  data: string; // base64 raw PCM24
}

export interface InterruptedUpdate {
  type: "interrupted";
}

export interface TurnCompleteUpdate {
  type: "turnComplete";
}

export interface ToolCallUpdate {
  type: "toolCall";
  functionCalls: Array<{
    name: string;
    args: any;
    id: string;
  }>;
}

export type ServerMessage = StatusUpdate | AudioUpdate | InterruptedUpdate | TurnCompleteUpdate | ToolCallUpdate;
