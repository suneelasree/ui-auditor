// Tracks the one sign-in window the Web UI may have open at a time.
import { randomUUID } from 'node:crypto';
import type { SignInWindow } from './browser.js';
import { originOf, type SessionStore } from './store.js';

export type SignInStatus = 'waiting' | 'saved' | 'cancelled' | 'failed' | 'timeout';

export interface SignInState {
  id: string;
  origin: string;
  status: SignInStatus;
  message: string;
}

export type SignInLauncher = (url: string) => Promise<SignInWindow>;

const TIMEOUT_MS = 10 * 60_000;

export class SignInManager {
  private current: { state: SignInState; win?: SignInWindow; timer?: NodeJS.Timeout } | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly launch: SignInLauncher,
  ) {}

  get(id: string): SignInState | undefined {
    return this.current?.state.id === id ? { ...this.current.state } : undefined;
  }

  /** Opens the window. Throws { running } if another sign-in is still waiting. */
  async start(url: string): Promise<SignInState> {
    const origin = originOf(url);
    if (!origin) throw new Error('Must be an http(s) URL');
    if (this.current?.state.status === 'waiting') throw Object.assign(new Error('A sign-in window is already open'), { running: this.current.state.id });

    const state: SignInState = { id: `si_${randomUUID().slice(0, 8)}`, origin, status: 'waiting', message: 'Sign in in the window that opened.' };
    const entry: { state: SignInState; win?: SignInWindow; timer?: NodeJS.Timeout } = { state };
    this.current = entry;

    const win = await this.launch(url);
    entry.win = win;
    entry.timer = setTimeout(() => void this.finish(entry, 'timeout', 'Timed out after 10 minutes. Try again.'), TIMEOUT_MS);
    win.onClosed(() => {
      if (entry.state.status === 'waiting') void this.finish(entry, 'cancelled', 'The sign-in window was closed before signing in.');
    });
    win.waitForSignedIn().then(
      () => this.save(entry),
      () => undefined, // closed or cancelled: onClosed / cancel already set the state
    );
    return { ...state };
  }

  /** The user says they are signed in: save now. */
  async done(id: string): Promise<SignInState | undefined> {
    const entry = this.current;
    if (!entry || entry.state.id !== id) return undefined;
    if (entry.state.status === 'waiting') await this.save(entry);
    return { ...entry.state };
  }

  async cancel(id: string): Promise<SignInState | undefined> {
    const entry = this.current;
    if (!entry || entry.state.id !== id) return undefined;
    if (entry.state.status === 'waiting') await this.finish(entry, 'cancelled', 'Sign-in cancelled.');
    return { ...entry.state };
  }

  private async save(entry: { state: SignInState; win?: SignInWindow }): Promise<void> {
    if (entry.state.status !== 'waiting' || !entry.win) return;
    try {
      await entry.win.saveState(this.store.prepare(entry.state.origin));
      await this.finish(entry, 'saved', 'Signed in. Session saved for this site.');
    } catch (err) {
      await this.finish(entry, 'failed', `Could not save the session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async finish(
    entry: { state: SignInState; win?: SignInWindow; timer?: NodeJS.Timeout },
    status: SignInStatus,
    message: string,
  ): Promise<void> {
    if (entry.state.status !== 'waiting') return;
    entry.state.status = status;
    entry.state.message = message;
    if (entry.timer) clearTimeout(entry.timer);
    await entry.win?.close();
  }
}
