export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  workspaces: WorkspaceMembership[];
}

export interface ConversationSummary {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed' | string;
  updatedAt: string;
  lastMessage: {
    text: string;
    direction: 'inbound' | 'outbound' | string;
    at: string;
  } | null;
}

export interface MessageItem {
  id: string;
  client_ref?: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status?: 'queued' | 'processing' | 'sent' | 'delivered' | 'failed' | string;
  timestamp: string;
}

export interface EncryptedNote {
  id: string;
  authorSub: string;
  ciphertext: string;
  iv: string;
  createdAt: string;
}

export interface WsFrame {
  seq: number;
  type: 'message.inbound' | 'message.status' | 'conversation.assigned' | 'conversation.status' | string;
  contact?: string;
  message_id?: string;
  text?: string;
  occurred_at?: string;
  client_ref?: string;
  status?: string;
  assignee?: string | null;
}
