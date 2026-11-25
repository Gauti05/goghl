import { useCallback, useEffect, useMemo, useState } from 'react';
import { decryptNote, encryptNote } from './lib/crypto';
import { useWebSocket } from './hooks/useWebSocket';
import type {
  ConversationSummary,
  EncryptedNote,
  MessageItem,
  SessionUser,
  WsFrame,
} from './types';

type FilterTab = 'all' | 'unassigned' | 'mine' | 'closed';

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');

  const [activeConv, setActiveConv] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [notes, setNotes] = useState<EncryptedNote[]>([]);
  const [decryptedNotes, setDecryptedNotes] = useState<Record<string, string>>({});

  const [replyText, setReplyText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteKey, setNoteKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Load session on mount
  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SessionUser | null) => {
        setUser(data);
        if (data && data.workspaces.length > 0) {
          setWorkspace(data.workspaces[0]!.id);
        }
      })
      .catch(() => setUser(null));
  }, []);

  // Load saved workspace encryption key from localStorage (never sent to server)
  useEffect(() => {
    if (!workspace) return;
    setNoteKey(localStorage.getItem(`sb_note_key:${workspace}`) ?? '');
  }, [workspace]);

  const fetchConversations = useCallback(async (ws: string) => {
    const res = await fetch(`/api/conversations?workspace=${encodeURIComponent(ws)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { conversations: ConversationSummary[] };
    setConversations(data.conversations);
  }, []);

  const fetchThread = useCallback(async (ws: string, contact: string) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}?workspace=${encodeURIComponent(ws)}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      conversation: ConversationSummary;
      messages: MessageItem[];
      notes: EncryptedNote[];
    };
    setActiveConv(data.conversation);
    setMessages(data.messages);
    setNotes(data.notes);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setSelectedContact(null);
    setActiveConv(null);
    setMessages([]);
    setNotes([]);
    void fetchConversations(workspace);
  }, [workspace, fetchConversations]);

  useEffect(() => {
    if (!workspace || !selectedContact) return;
    void fetchThread(workspace, selectedContact);
  }, [workspace, selectedContact, fetchThread]);

  // Decrypt notes client-side whenever notes or passphrase changes
  useEffect(() => {
    if (!workspace || !noteKey) {
      setDecryptedNotes({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: Record<string, string> = {};
      for (const n of notes) {
        try {
          out[n.id] = await decryptNote(workspace, noteKey, n.ciphertext, n.iv);
        } catch {
          out[n.id] = '[Unable to decrypt with current workspace key]';
        }
      }
      if (!cancelled) setDecryptedNotes(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, notes, noteKey]);

  const handleWsFrame = useCallback(
    (frame: WsFrame) => {
      if (!workspace) return;
      if (frame.type === 'message.inbound' && frame.contact && frame.message_id) {
        void fetchConversations(workspace);
        if (frame.contact === selectedContact) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === frame.message_id)) return prev;
            return [
              ...prev,
              {
                id: frame.message_id!,
                direction: 'inbound',
                text: frame.text ?? '',
                timestamp: frame.occurred_at ?? new Date().toISOString(),
              },
            ];
          });
        }
      } else if (frame.type === 'message.status' && frame.client_ref && frame.status) {
        setMessages((prev) =>
          prev.map((m) =>
            m.client_ref === frame.client_ref || m.id === frame.client_ref
              ? { ...m, status: frame.status }
              : m,
          ),
        );
      } else if (frame.type === 'conversation.assigned' && frame.contact) {
        setConversations((prev) =>
          prev.map((c) =>
            c.contact === frame.contact ? { ...c, assignee: frame.assignee ?? null } : c,
          ),
        );
        if (frame.contact === selectedContact) {
          setActiveConv((prev) => (prev ? { ...prev, assignee: frame.assignee ?? null } : prev));
        }
      } else if (frame.type === 'conversation.status' && frame.contact && frame.status) {
        setConversations((prev) =>
          prev.map((c) => (c.contact === frame.contact ? { ...c, status: frame.status! } : c)),
        );
        if (frame.contact === selectedContact) {
          setActiveConv((prev) => (prev ? { ...prev, status: frame.status! } : prev));
        }
      }
    },
    [workspace, selectedContact, fetchConversations],
  );

  const wsStatus = useWebSocket(workspace, handleWsFrame);

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (filter === 'unassigned') return !c.assignee && c.status !== 'closed';
      if (filter === 'mine') return c.assignee === user?.sub;
      if (filter === 'closed') return c.status === 'closed';
      return true;
    });
  }, [conversations, filter, user?.sub]);

  const activeRole = useMemo(() => {
    return user?.workspaces.find((w) => w.id === workspace)?.role ?? 'agent';
  }, [user, workspace]);

  async function handleClaimToggle() {
    if (!workspace || !activeConv) return;
    setError(null);
    const isMine = activeConv.assignee === user?.sub;
    const action = isMine ? 'unclaim' : 'claim';
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(activeConv.contact)}/${action}?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Failed to ${action}`);
      return;
    }
    void fetchThread(workspace, activeConv.contact);
    void fetchConversations(workspace);
  }

  async function handleStatusToggle() {
    if (!workspace || !activeConv) return;
    setError(null);
    const action = activeConv.status === 'closed' ? 'reopen' : 'close';
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(activeConv.contact)}/${action}?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      setError(`Failed to ${action} conversation`);
      return;
    }
    void fetchThread(workspace, activeConv.contact);
    void fetchConversations(workspace);
  }

  async function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !selectedContact || !replyText.trim()) return;
    setError(null);
    const text = replyText.trim();
    const clientRef = `ui_${crypto.randomUUID()}`;
    setReplyText('');

    setMessages((prev) => [
      ...prev,
      {
        id: clientRef,
        client_ref: clientRef,
        direction: 'outbound',
        text,
        status: 'queued',
        timestamp: new Date().toISOString(),
      },
    ]);

    const res = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/reply?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, client_ref: clientRef }),
      },
    );
    if (!res.ok) {
      setError('Failed to send reply');
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !selectedContact || !noteText.trim() || !noteKey) return;
    setError(null);
    const { ciphertext, iv } = await encryptNote(workspace, noteKey, noteText.trim());
    setNoteText('');

    const res = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/notes?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext, iv }),
      },
    );
    if (res.ok) {
      const created = (await res.json()) as EncryptedNote;
      setNotes((prev) => [...prev, created]);
    } else {
      setError('Failed to save encrypted note');
    }
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
    setWorkspace(null);
  }

  if (user === undefined) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Loading session…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Shared team inbox for customer messaging</p>
          <a className="btn btn-primary" href="/auth/login">
            Sign in with Switchboard IdP
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Switchboard</span>
          <select
            className="select"
            aria-label="Workspace"
            value={workspace ?? ''}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id}
              </option>
            ))}
          </select>
          <span className={`badge ${activeRole === 'admin' ? 'badge-admin' : 'badge-agent'}`}>
            {activeRole}
          </span>
          <span className={`badge ${wsStatus === 'connected' ? 'badge-live' : 'badge-warn'}`}>
            {wsStatus === 'connected' ? 'Live' : wsStatus}
          </span>
        </div>

        <div className="topbar-right">
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {user.name} ({user.email})
          </span>
          <button className="btn" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="workspace-body">
        <aside className="sidebar">
          <div className="filter-tabs">
            {(['all', 'unassigned', 'mine', 'closed'] as FilterTab[]).map((t) => (
              <button
                key={t}
                className={`tab ${filter === t ? 'active' : ''}`}
                onClick={() => setFilter(t)}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          <div className="conv-list">
            {filteredConversations.length === 0 && (
              <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
                No conversations in this view.
              </div>
            )}
            {filteredConversations.map((c) => (
              <button
                key={c.contact}
                className={`conv-item ${selectedContact === c.contact ? 'selected' : ''}`}
                onClick={() => setSelectedContact(c.contact)}
              >
                <div className="conv-row">
                  <span className="conv-contact">{c.contact}</span>
                  <span className={`badge ${c.status === 'closed' ? 'badge-closed' : ''}`}>
                    {c.assignee ?? 'unassigned'}
                  </span>
                </div>
                <div className="conv-snippet">
                  {c.lastMessage ? c.lastMessage.text : 'No messages yet'}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="thread-pane">
          {!activeConv ? (
            <div className="thread-empty">Select a conversation to view messages</div>
          ) : (
            <>
              <div className="thread-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong>{activeConv.contact}</strong>
                  <span className={`badge ${activeConv.status === 'closed' ? 'badge-closed' : 'badge-live'}`}>
                    {activeConv.status}
                  </span>
                  <span className="badge">
                    {activeConv.assignee ? `Held by ${activeConv.assignee}` : 'Unassigned'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    onClick={handleClaimToggle}
                    disabled={
                      activeConv.assignee !== null &&
                      activeConv.assignee !== user.sub &&
                      activeRole !== 'admin'
                    }
                  >
                    {activeConv.assignee === user.sub ? 'Unclaim' : 'Claim'}
                  </button>
                  <button className="btn" onClick={handleStatusToggle}>
                    {activeConv.status === 'closed' ? 'Reopen' : 'Close'}
                  </button>
                </div>
              </div>

              <div className="thread-content">
                <div className="messages-col">
                  <div className="messages-list">
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={`msg-bubble ${
                          m.direction === 'inbound' ? 'msg-inbound' : 'msg-outbound'
                        }`}
                      >
                        <div>{m.text}</div>
                        <div className="msg-meta">
                          <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                          {m.direction === 'outbound' && m.status && (
                            <span style={{ fontWeight: 700 }}>{m.status}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <form className="reply-box" onSubmit={handleSendReply}>
                    <input
                      className="input"
                      placeholder="Write a reply…"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                    />
                    <button className="btn btn-primary" type="submit" disabled={!replyText.trim()}>
                      Send
                    </button>
                  </form>
                </div>

                <aside className="notes-panel">
                  <h3>Private Notes (E2EE)</h3>
                  <input
                    className="input"
                    type="password"
                    placeholder="Workspace encryption key…"
                    value={noteKey}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNoteKey(val);
                      if (workspace) localStorage.setItem(`sb_note_key:${workspace}`, val);
                    }}
                  />

                  <div className="notes-list">
                    {notes.map((n) => (
                      <div key={n.id} className="note-card">
                        <div className="note-author">{n.authorSub}</div>
                        <div>
                          {noteKey
                            ? (decryptedNotes[n.id] ?? 'Decrypting…')
                            : '[Enter workspace key to decrypt]'}
                        </div>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleAddNote} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input
                      className="input"
                      placeholder={noteKey ? 'Add encrypted note…' : 'Set key above first'}
                      disabled={!noteKey}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                    />
                    <button
                      className="btn"
                      type="submit"
                      disabled={!noteKey || !noteText.trim()}
                    >
                      Save Encrypted Note
                    </button>
                  </form>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
