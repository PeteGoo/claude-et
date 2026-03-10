import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Terminal, Play, Pause, Square, Trash2, Plus, Settings,
  RefreshCw, Copy, Check, Github, Server, ChevronRight,
  ChevronLeft, X, AlertCircle, Loader, HardDrive, Key,
  Search, ScrollText, ArrowDown
} from 'lucide-react'

// ─── API helpers ──────────────────────────────────────────────────────────────

const api = {
  get: (path) => fetch(`/api${path}`).then(r => r.json()),
  post: (path, body) => fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  put: (path, body) => fetch(`/api${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  delete: (path) => fetch(`/api${path}`, { method: 'DELETE' }).then(r => r.json()),
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    running: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    paused: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    stopped: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
    starting: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
    error: 'bg-red-500/20 text-red-400 border-red-500/30',
  }
  const dot = {
    running: 'bg-emerald-400 animate-pulse',
    paused: 'bg-amber-400',
    stopped: 'bg-zinc-500',
    starting: 'bg-violet-400 animate-pulse',
    error: 'bg-red-400',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${map[status] || map.stopped}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot[status] || dot.stopped}`} />
      {status}
    </span>
  )
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className={`p-1 rounded hover:bg-white/10 transition-colors ${className}`}>
      {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-zinc-400" />}
    </button>
  )
}

// ─── SSH Modal ────────────────────────────────────────────────────────────────

function SSHModal({ session, onClose }) {
  const [ssh, setSsh] = useState(null)
  useEffect(() => {
    api.get(`/sessions/${session.id}/ssh`).then(setSsh)
  }, [session.id])

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <h3 className="font-semibold text-white flex items-center gap-2">
            <Terminal size={16} className="text-emerald-400" /> Connect to {session.name}
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          {!ssh ? (
            <div className="flex justify-center py-6"><Loader size={20} className="animate-spin text-zinc-400" /></div>
          ) : (
            <>
              <div>
                <p className="text-xs text-zinc-500 mb-2">Direct SSH connection</p>
                <div className="flex items-center gap-2 bg-black rounded-lg p-3 font-mono text-sm text-emerald-400">
                  <span className="flex-1 break-all">{ssh.command}</span>
                  <CopyButton text={ssh.command} />
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-2">SSH + attach to tmux session (recommended)</p>
                <div className="flex items-center gap-2 bg-black rounded-lg p-3 font-mono text-sm text-emerald-400">
                  <span className="flex-1 break-all">{ssh.oneLiner}</span>
                  <CopyButton text={ssh.oneLiner} />
                </div>
              </div>
              <div className="bg-zinc-800 rounded-lg p-3 text-xs text-zinc-400 space-y-1">
                <p><span className="text-zinc-300">Host:</span> {ssh.hostname}</p>
                <p><span className="text-zinc-300">Port:</span> {ssh.port}</p>
                <p><span className="text-zinc-300">User:</span> root</p>
                <p><span className="text-zinc-300">Session:</span> claude-main</p>
              </div>
              {session.status !== 'running' && (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-400">
                  <AlertCircle size={14} />
                  Session is {session.status} — resume it first
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── New Session Wizard ───────────────────────────────────────────────────────

function NewSessionWizard({ images, onClose, onCreated }) {
  const [step, setStep] = useState(1)
  const [selectedImage, setSelectedImage] = useState(images[0]?.id || '')
  const [repoMode, setRepoMode] = useState('existing') // 'existing' | 'new'
  const [selectedRepos, setSelectedRepos] = useState([])
  const [newRepoName, setNewRepoName] = useState('')
  const [pushToGitHub, setPushToGitHub] = useState(true)
  const [sessionName, setSessionName] = useState('')
  const [githubRepos, setGithubRepos] = useState([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [repoSearch, setRepoSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  // Pending repos list — can mix new + existing
  const [pendingRepos, setPendingRepos] = useState([])

  useEffect(() => {
    if (step === 2) {
      setLoadingRepos(true)
      api.get('/github/repos')
        .then(data => { setGithubRepos(Array.isArray(data) ? data : []); setLoadingRepos(false) })
        .catch(() => { setGithubRepos([]); setLoadingRepos(false) })
    }
  }, [step])

  const filteredRepos = githubRepos.filter(r =>
    r.fullName.toLowerCase().includes(repoSearch.toLowerCase())
  )

  const addRepo = () => {
    if (repoMode === 'new') {
      if (!newRepoName.trim()) return
      setPendingRepos(prev => [...prev, {
        name: newRepoName.trim(),
        cloneUrl: '',
        localPath: `/repos/${newRepoName.trim()}`,
        type: 'new',
        pushToGitHub,
      }])
      setNewRepoName('')
    } else {
      const toAdd = githubRepos
        .filter(r => selectedRepos.includes(r.fullName) && !pendingRepos.find(p => p.name === r.name))
        .map(r => ({
          name: r.name,
          cloneUrl: r.cloneUrl,
          localPath: `/repos/${r.name}`,
          type: 'clone',
          pushToGitHub: false,
        }))
      setPendingRepos(prev => [...prev, ...toAdd])
      setSelectedRepos([])
    }
  }

  const toggleRepoSelect = (fullName) => {
    setSelectedRepos(prev =>
      prev.includes(fullName) ? prev.filter(r => r !== fullName) : [...prev, fullName]
    )
  }

  const derivedName = sessionName || pendingRepos.map(r => r.name).join(', ') || 'New Session'

  const launch = async () => {
    if (!pendingRepos.length) { setError('Add at least one repo'); return }
    setCreating(true)
    try {
      const session = await api.post('/sessions', {
        name: derivedName,
        baseImageId: selectedImage,
        repos: pendingRepos,
      })
      if (session.error) throw new Error(session.error)
      onCreated(session)
      onClose()
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-700 shrink-0">
          <h2 className="font-semibold text-white">New Session</h2>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {[1, 2, 3].map(n => (
                <div key={n} className={`h-1.5 w-6 rounded-full transition-colors ${step >= n ? 'bg-violet-500' : 'bg-zinc-700'}`} />
              ))}
            </div>
            <button onClick={onClose} className="text-zinc-400 hover:text-white"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* Step 1: Pick image */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">Choose an environment for this session</p>
              {images.length === 0 ? (
                <div className="text-center py-8 text-zinc-500 text-sm">
                  No base images configured. Add one in Settings → Base Images.
                </div>
              ) : (
                images.map(img => (
                  <button
                    key={img.id}
                    onClick={() => setSelectedImage(img.id)}
                    className={`w-full text-left p-4 rounded-xl border transition-all ${
                      selectedImage === img.id
                        ? 'border-violet-500 bg-violet-500/10'
                        : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        selectedImage === img.id ? 'border-violet-500' : 'border-zinc-600'
                      }`}>
                        {selectedImage === img.id && <div className="w-2 h-2 rounded-full bg-violet-500" />}
                      </div>
                      <div>
                        <p className="font-medium text-white">{img.alias}</p>
                        <p className="text-xs text-zinc-500 font-mono">{img.dockerImage}</p>
                        {img.description && <p className="text-xs text-zinc-500 mt-0.5">{img.description}</p>}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Step 2: Repos */}
          {step === 2 && (
            <div className="space-y-4">
              {/* Pending repos */}
              {pendingRepos.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide">Repos for this session</p>
                  {pendingRepos.map((r, i) => (
                    <div key={i} className="flex items-center gap-3 bg-zinc-800 rounded-lg px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        r.type === 'new' ? 'bg-violet-500/20 text-violet-400' : 'bg-emerald-500/20 text-emerald-400'
                      }`}>{r.type}</span>
                      <span className="text-sm text-white flex-1">{r.name}</span>
                      {r.pushToGitHub && <span className="text-xs text-zinc-500">→ GitHub</span>}
                      <button onClick={() => setPendingRepos(prev => prev.filter((_, j) => j !== i))}
                        className="text-zinc-600 hover:text-red-400"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* Mode toggle */}
              <div className="flex gap-2">
                {['existing', 'new'].map(m => (
                  <button key={m} onClick={() => setRepoMode(m)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      repoMode === m ? 'bg-violet-500 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                    }`}>
                    {m === 'existing' ? 'Clone existing' : 'New repo'}
                  </button>
                ))}
              </div>

              {repoMode === 'existing' && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      value={repoSearch}
                      onChange={e => setRepoSearch(e.target.value)}
                      placeholder="Search repos..."
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  <div className="max-h-52 overflow-y-auto space-y-1 rounded-lg border border-zinc-700">
                    {loadingRepos ? (
                      <div className="flex justify-center py-6"><Loader size={18} className="animate-spin text-zinc-500" /></div>
                    ) : filteredRepos.length === 0 ? (
                      <p className="text-center py-6 text-sm text-zinc-500">No repos found</p>
                    ) : (
                      filteredRepos.map(r => (
                        <button key={r.fullName} onClick={() => toggleRepoSelect(r.fullName)}
                          className={`w-full text-left flex items-center gap-3 px-3 py-2 transition-colors hover:bg-zinc-700 ${
                            selectedRepos.includes(r.fullName) ? 'bg-zinc-700' : ''
                          }`}>
                          <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            selectedRepos.includes(r.fullName) ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                          }`}>
                            {selectedRepos.includes(r.fullName) && <Check size={10} className="text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{r.fullName}</p>
                            {r.org && <p className="text-xs text-zinc-500">{r.org}</p>}
                          </div>
                          {r.private && <span className="text-xs text-zinc-600">private</span>}
                        </button>
                      ))
                    )}
                  </div>
                  <button onClick={addRepo} disabled={!selectedRepos.length}
                    className="text-sm text-violet-400 hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed">
                    + Add {selectedRepos.length > 0 ? `${selectedRepos.length} selected` : 'selected repos'}
                  </button>
                </div>
              )}

              {repoMode === 'new' && (
                <div className="space-y-3">
                  <input
                    value={newRepoName}
                    onChange={e => setNewRepoName(e.target.value.replace(/\s/g, '-'))}
                    placeholder="repo-name"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono"
                  />
                  <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                    <input type="checkbox" checked={pushToGitHub} onChange={e => setPushToGitHub(e.target.checked)}
                      className="rounded border-zinc-600 text-violet-500" />
                    Create & push to GitHub org
                  </label>
                  <button onClick={addRepo} disabled={!newRepoName.trim()}
                    className="text-sm text-violet-400 hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed">
                    + Add repo
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Review */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wide block mb-2">Session name</label>
                <input
                  value={sessionName}
                  onChange={e => setSessionName(e.target.value)}
                  placeholder={derivedName}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                />
              </div>
              <div className="bg-zinc-800 rounded-xl p-4 space-y-3 text-sm">
                <div className="flex justify-between text-zinc-400">
                  <span>Environment</span>
                  <span className="text-white">{images.find(i => i.id === selectedImage)?.alias}</span>
                </div>
                <div className="border-t border-zinc-700 pt-3">
                  <p className="text-zinc-400 mb-2">Repos</p>
                  {pendingRepos.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-white py-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        r.type === 'new' ? 'bg-violet-500/20 text-violet-400' : 'bg-emerald-500/20 text-emerald-400'
                      }`}>{r.type}</span>
                      {r.name}
                      {r.pushToGitHub && <span className="text-zinc-500 text-xs">→ GitHub org</span>}
                    </div>
                  ))}
                </div>
              </div>
              {error && (
                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
                  <AlertCircle size={14} />{error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between p-4 border-t border-zinc-700 shrink-0">
          <button onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white transition-colors">
            <ChevronLeft size={16} />
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={step === 1 && !selectedImage || step === 2 && pendingRepos.length === 0}
              className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button onClick={launch} disabled={creating}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              {creating ? <><Loader size={14} className="animate-spin" /> Launching...</> : <><Play size={14} /> Launch</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingsPanel({ onClose }) {
  const [config, setConfig] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenStatus, setTokenStatus] = useState(null) // null | {valid, login}
  const [images, setImages] = useState([])
  const [newImage, setNewImage] = useState({ alias: '', dockerImage: '', description: '' })
  const [tab, setTab] = useState('general') // 'general' | 'images'

  useEffect(() => {
    api.get('/settings').then(setConfig)
    api.get('/images').then(setImages)
  }, [])

  const save = async () => {
    setSaving(true)
    await api.put('/settings', config)
    setSaving(false)
  }

  const saveToken = async () => {
    const result = await api.put('/settings/github-token', { token: tokenInput })
    setTokenStatus(result)
    if (result.valid) setTokenInput('')
  }

  const addImage = async () => {
    if (!newImage.alias || !newImage.dockerImage) return
    const img = await api.post('/images', newImage)
    setImages(prev => [...prev, img])
    setNewImage({ alias: '', dockerImage: '', description: '' })
  }

  const deleteImage = async (id) => {
    await api.delete(`/images/${id}`)
    setImages(prev => prev.filter(i => i.id !== id))
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-zinc-700 shrink-0">
          <h2 className="font-semibold text-white flex items-center gap-2"><Settings size={16} /> Settings</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white"><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-700 shrink-0">
          {[['general', 'General'], ['images', 'Base Images']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
                tab === id ? 'border-violet-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
              }`}>{label}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!config ? (
            <div className="flex justify-center py-8"><Loader size={20} className="animate-spin text-zinc-500" /></div>
          ) : tab === 'general' ? (
            <div className="space-y-5">
              {/* GitHub Token */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2"><Key size={14} /> GitHub</h3>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1.5">Personal Access Token</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={e => setTokenInput(e.target.value)}
                      placeholder={config.githubTokenSet ? '••••••••' + '  (token saved)' : 'ghp_...'}
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                    />
                    <button onClick={saveToken} disabled={!tokenInput}
                      className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                      Save
                    </button>
                  </div>
                  {tokenStatus && (
                    <p className={`text-xs mt-1 ${tokenStatus.valid ? 'text-emerald-400' : 'text-red-400'}`}>
                      {tokenStatus.valid ? `✓ Authenticated as @${tokenStatus.login}` : `✗ ${tokenStatus.error}`}
                    </p>
                  )}
                  <p className="text-xs text-zinc-600 mt-1">Needs repo + admin:org scopes</p>
                </div>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1.5">Default GitHub Org</label>
                  <input
                    value={config.githubOrg}
                    onChange={e => setConfig(c => ({ ...c, githubOrg: e.target.value }))}
                    placeholder="your-org"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                  />
                </div>
              </section>

              {/* Tailscale */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2"><Server size={14} /> Connection</h3>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1.5">Tailscale Hostname</label>
                  <input
                    value={config.tailscaleHostname}
                    onChange={e => setConfig(c => ({ ...c, tailscaleHostname: e.target.value }))}
                    placeholder="your-unraid.tailnet.ts.net"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1.5">Your SSH Public Key</label>
                  <textarea
                    value={config.sshPublicKey}
                    onChange={e => setConfig(c => ({ ...c, sshPublicKey: e.target.value }))}
                    placeholder="ssh-ed25519 AAAA..."
                    rows={2}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono resize-none"
                  />
                  <p className="text-xs text-zinc-600 mt-1">Injected into each container's authorized_keys</p>
                </div>
              </section>

              {/* Storage */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2"><HardDrive size={14} /> Storage</h3>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1.5">Sessions path (on Unraid host)</label>
                  <input
                    value={config.sessionsPath}
                    onChange={e => setConfig(c => ({ ...c, sessionsPath: e.target.value }))}
                    placeholder="/mnt/user/claude-sessions"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono"
                  />
                </div>
              </section>

              {/* Git identity */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2"><Github size={14} /> Git identity</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1.5">Name</label>
                    <input value={config.gitName} onChange={e => setConfig(c => ({ ...c, gitName: e.target.value }))}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500" />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1.5">Email</label>
                    <input value={config.gitEmail} onChange={e => setConfig(c => ({ ...c, gitEmail: e.target.value }))}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500" />
                  </div>
                </div>
              </section>
            </div>
          ) : (
            /* Base Images tab */
            <div className="space-y-4">
              {images.map(img => (
                <div key={img.id} className="flex items-center gap-3 bg-zinc-800 rounded-xl p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{img.alias}</p>
                    <p className="text-xs text-zinc-500 font-mono truncate">{img.dockerImage}</p>
                    {img.description && <p className="text-xs text-zinc-600 mt-0.5">{img.description}</p>}
                  </div>
                  <button onClick={() => deleteImage(img.id)} className="text-zinc-600 hover:text-red-400 p-1">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <div className="border border-zinc-700 rounded-xl p-4 space-y-3">
                <p className="text-sm font-medium text-zinc-300">Add image</p>
                <input value={newImage.alias} onChange={e => setNewImage(p => ({ ...p, alias: e.target.value }))}
                  placeholder="Alias (e.g. Node 20 + Claude)"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500" />
                <input value={newImage.dockerImage} onChange={e => setNewImage(p => ({ ...p, dockerImage: e.target.value }))}
                  placeholder="Docker image (e.g. claude-session:node20)"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono" />
                <input value={newImage.description} onChange={e => setNewImage(p => ({ ...p, description: e.target.value }))}
                  placeholder="Description (optional)"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500" />
                <button onClick={addImage} disabled={!newImage.alias || !newImage.dockerImage}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm px-3 py-2 rounded-lg transition-colors">
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          )}
        </div>

        {tab === 'general' && (
          <div className="p-4 border-t border-zinc-700 shrink-0 flex justify-end">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              {saving ? <><Loader size={14} className="animate-spin" /> Saving...</> : <>Save settings</>}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Logs Modal ──────────────────────────────────────────────────────────────

function LogsModal({ session, onClose }) {
  const [logs, setLogs] = useState('')
  const [tail, setTail] = useState(200)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const containerNodeRef = useRef(null)
  const containerRef = useCallback(node => {
    if (node) {
      containerNodeRef.current = node
      // Scroll to bottom on mount
      node.scrollTop = node.scrollHeight
    }
  }, [])

  const fetchLogs = useCallback(async (numLines) => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get(`/sessions/${session.id}/logs?tail=${numLines}`)
      if (data.error) {
        setError(data.error)
        setLogs('')
      } else {
        setLogs(data.logs || '')
      }
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [session.id])

  // Initial load
  useEffect(() => {
    fetchLogs(tail)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom after logs update
  useEffect(() => {
    const el = containerNodeRef.current
    if (el && atBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = (e) => {
    const el = e.target
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAtBottom(nearBottom)

    // If scrolled to top, load more lines
    if (el.scrollTop === 0 && !loading) {
      const prevHeight = el.scrollHeight
      const newTail = Math.min(tail + 500, 10000)
      if (newTail !== tail) {
        setTail(newTail)
        fetchLogs(newTail).then(() => {
          // Preserve scroll position after loading more
          requestAnimationFrame(() => {
            if (containerNodeRef.current) {
              containerNodeRef.current.scrollTop = containerNodeRef.current.scrollHeight - prevHeight
            }
          })
        })
      }
    }
  }

  const scrollToBottom = () => {
    const el = containerNodeRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      setAtBottom(true)
    }
  }

  const refresh = () => {
    fetchLogs(tail).then(() => {
      requestAnimationFrame(() => {
        const el = containerNodeRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
      setAtBottom(true)
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col relative">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-700 shrink-0">
          <h3 className="font-semibold text-white flex items-center gap-2">
            <ScrollText size={16} className="text-violet-400" /> Logs — {session.name}
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">{tail} lines</span>
            <button onClick={refresh} title="Refresh logs"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="text-zinc-400 hover:text-white"><X size={18} /></button>
          </div>
        </div>

        {/* Log content */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto bg-black p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap break-all leading-relaxed"
        >
          {loading && !logs && (
            <div className="flex justify-center py-12"><Loader size={20} className="animate-spin text-zinc-500" /></div>
          )}
          {error && !logs && (
            <div className="flex items-center gap-2 text-red-400 py-4">
              <AlertCircle size={14} />{error}
            </div>
          )}
          {logs && (
            <>
              {loading && (
                <div className="text-center text-zinc-600 py-1 mb-2">Loading more...</div>
              )}
              {logs}
            </>
          )}
        </div>

        {/* Scroll-to-bottom FAB */}
        {!atBottom && (
          <button onClick={scrollToBottom}
            className="absolute bottom-20 right-10 p-2 bg-violet-600 hover:bg-violet-500 text-white rounded-full shadow-lg transition-colors">
            <ArrowDown size={16} />
          </button>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-700 shrink-0 text-xs text-zinc-500">
          <span>Scroll to top to load more lines</span>
          {session.status !== 'running' && (
            <span className="flex items-center gap-1 text-amber-400">
              <AlertCircle size={11} />Container is {session.status}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Session Card ─────────────────────────────────────────────────────────────

function SessionCard({ session, images, onAction, onConnect, onLogs }) {
  const [actioning, setActioning] = useState(null)

  const act = async (action) => {
    setActioning(action)
    await onAction(session.id, action)
    setActioning(null)
  }

  const image = images.find(i => i.id === session.baseImageId)
  const canPause = session.status === 'running'
  const canResume = ['paused', 'stopped'].includes(session.status)
  const canStop = ['running', 'paused'].includes(session.status)

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 flex items-center gap-4 hover:border-zinc-600 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-white truncate">{session.name}</span>
          <StatusBadge status={session.status} />
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {image && <span className="flex items-center gap-1"><Server size={11} />{image.alias}</span>}
          <span>{session.repos?.length} repo{session.repos?.length !== 1 ? 's' : ''}</span>
          <span>:{session.sshPort}</span>
        </div>
        {session.errorMessage && (
          <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
            <AlertCircle size={11} />{session.errorMessage}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* SSH connect */}
        <button onClick={() => onConnect(session)}
          title="SSH connection info"
          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors">
          <Terminal size={15} />
        </button>

        {/* Container logs */}
        {session.containerId && (
          <button onClick={() => onLogs(session)}
            title="View container logs"
            className="p-2 rounded-lg text-zinc-400 hover:text-violet-400 hover:bg-zinc-700 transition-colors">
            <ScrollText size={15} />
          </button>
        )}

        {/* Pause */}
        {canPause && (
          <button onClick={() => act('pause')} title="Pause (freeze in RAM)"
            className="p-2 rounded-lg text-zinc-400 hover:text-amber-400 hover:bg-zinc-700 transition-colors">
            {actioning === 'pause' ? <Loader size={15} className="animate-spin" /> : <Pause size={15} />}
          </button>
        )}

        {/* Resume */}
        {canResume && (
          <button onClick={() => act('resume')} title={session.status === 'stopped' ? 'Restart (fresh container, repos preserved)' : 'Resume'}
            className="p-2 rounded-lg text-zinc-400 hover:text-emerald-400 hover:bg-zinc-700 transition-colors">
            {actioning === 'resume' ? <Loader size={15} className="animate-spin" /> : <Play size={15} />}
          </button>
        )}

        {/* Stop */}
        {canStop && (
          <button onClick={() => act('stop')} title="Stop (frees RAM, repos kept on disk)"
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-300 hover:bg-zinc-700 transition-colors">
            {actioning === 'stop' ? <Loader size={15} className="animate-spin" /> : <Square size={15} />}
          </button>
        )}

        {/* Delete */}
        <button onClick={() => act('delete')} title="Terminate (delete session)"
          className="p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-700 transition-colors">
          {actioning === 'delete' ? <Loader size={15} className="animate-spin" /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState([])
  const [images, setImages] = useState([])
  const [loading, setLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sshSession, setSshSession] = useState(null)
  const [logsSession, setLogsSession] = useState(null)

  const refresh = useCallback(async () => {
    const [s, i] = await Promise.all([api.get('/sessions'), api.get('/images')])
    setSessions(Array.isArray(s) ? s : [])
    setImages(Array.isArray(i) ? i : [])
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const handleAction = async (id, action) => {
    if (action === 'delete') {
      if (!confirm('Terminate this session? The session record and container will be deleted. Repos on disk are kept.')) return
      await api.delete(`/sessions/${id}`)
    } else {
      await api.post(`/sessions/${id}/${action}`, {})
    }
    await refresh()
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Nav */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal size={20} className="text-violet-400" />
          <span className="font-semibold">Claude Session Manager</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
            <RefreshCw size={16} />
          </button>
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors text-sm">
            <Settings size={15} /> Settings
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Sessions section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-medium text-zinc-300">Sessions</h2>
            <button onClick={() => setShowWizard(true)}
              className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors">
              <Plus size={15} /> New Session
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-12"><Loader size={24} className="animate-spin text-zinc-600" /></div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-zinc-700 rounded-xl">
              <Terminal size={32} className="text-zinc-700 mx-auto mb-3" />
              <p className="text-zinc-500 text-sm">No sessions yet</p>
              <button onClick={() => setShowWizard(true)}
                className="mt-4 text-sm text-violet-400 hover:text-violet-300">
                Create your first session →
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(s => (
                <SessionCard
                  key={s.id}
                  session={s}
                  images={images}
                  onAction={handleAction}
                  onConnect={setSshSession}
                  onLogs={setLogsSession}
                />
              ))}
            </div>
          )}
        </section>

        {/* Legend */}
        {sessions.length > 0 && (
          <section className="text-xs text-zinc-600 flex items-center gap-4">
            <span className="flex items-center gap-1"><Terminal size={11} /> SSH info</span>
            <span className="flex items-center gap-1"><ScrollText size={11} /> Logs</span>
            <span className="flex items-center gap-1"><Pause size={11} /> Pause (freeze in RAM)</span>
            <span className="flex items-center gap-1"><Square size={11} /> Stop (frees RAM, repos kept)</span>
            <span className="flex items-center gap-1"><Play size={11} /> Resume / Restart</span>
          </section>
        )}
      </main>

      {/* Modals */}
      {showWizard && (
        <NewSessionWizard
          images={images}
          onClose={() => setShowWizard(false)}
          onCreated={(s) => setSessions(prev => [s, ...prev])}
        />
      )}
      {showSettings && <SettingsPanel onClose={() => { setShowSettings(false); refresh() }} />}
      {sshSession && <SSHModal session={sshSession} onClose={() => setSshSession(null)} />}
      {logsSession && <LogsModal session={logsSession} onClose={() => setLogsSession(null)} />}
    </div>
  )
}
