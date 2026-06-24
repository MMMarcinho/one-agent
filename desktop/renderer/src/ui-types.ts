export type Block =
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'error'; message: string };

export type TurnStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface Turn {
  turnId: string;
  prompt: string;
  agentId?: string;
  reason?: string;
  blocks: Block[];
  status: TurnStatus;
}
