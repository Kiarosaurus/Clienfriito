import { useState, useEffect, useRef, type KeyboardEvent } from 'react'
import { MessageCircle, X, Send, Bot } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'

interface Message {
  sender: 'user' | 'watson'
  text: string
}

interface ChatResponse {
  response: string
  session_id: string
}

const WELCOME: Message = {
  sender: 'watson',
  text: '¡Hola! Soy Watson, el asistente del sistema climático. ¿En qué puedo ayudarte hoy?',
}

export default function FloatingChat() {
  const [isOpen, setIsOpen]       = useState(false)
  const [messages, setMessages]   = useState<Message[]>([WELCOME])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput]         = useState('')
  const [isTyping, setIsTyping]   = useState(false)

  const bottomRef    = useRef<HTMLDivElement>(null)
  const inputRef     = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom on new messages or typing indicator
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 50)
  }, [isOpen])

  async function sendMessage() {
    const text = input.trim()
    if (!text || isTyping) return

    setInput('')
    setMessages(prev => [...prev, { sender: 'user', text }])
    setIsTyping(true)

    try {
      const { data } = await api.post<ChatResponse>('/chat/', {
        session_id: sessionId ?? undefined,
        message: text,
      })
      setSessionId(data.session_id)
      setMessages(prev => [...prev, { sender: 'watson', text: data.response }])
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      setMessages(prev => [
        ...prev,
        { sender: 'watson', text: detail ?? 'Error al conectar con Watson. Inténtalo de nuevo.' },
      ])
    } finally {
      setIsTyping(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <>
      {/* Chat window */}
      {isOpen && (
        <div className="fixed bottom-20 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] sm:w-96 flex flex-col max-h-[520px] bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-700/60 border-b border-slate-700 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
                <Bot size={16} className="text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">Watson</p>
                <p className="text-xs text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                  En línea
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-600 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-slate-700 text-slate-200 rounded-bl-sm'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-slate-700 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 px-3 py-3 border-t border-slate-700 bg-slate-800/80 flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              placeholder="Escribe un mensaje…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isTyping}
              className="flex-1 bg-slate-700 border border-slate-600 rounded-xl px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition disabled:opacity-50"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isTyping}
              className="flex items-center justify-center w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white transition-colors shrink-0"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          isOpen
            ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            : 'bg-blue-600 text-white hover:bg-blue-500'
        }`}
        aria-label={isOpen ? 'Cerrar chat' : 'Abrir chat con Watson'}
      >
        {isOpen ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </>
  )
}
