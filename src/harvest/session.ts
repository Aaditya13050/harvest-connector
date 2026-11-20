import { UserFacingError } from '../core/errors.ts';
import { HarvestApiError, type HarvestClient } from './client.ts';
import { todayIn, type WeekStart } from './dates.ts';
import { toIanaTimeZone } from './timezones.ts';
import type { HarvestCompany, HarvestUser, ProjectAssignment, TimeEntry } from './types.ts';

/** What the connector stores (encrypted) with each authorization. */
export interface HarvestProps {
  /** Harvest personal access token. */
  token: string;
  accountId: string;
  accountName: string;
  userId: number;
  userName: string;
  /** Harvest (Rails-style) time zone name at connect time. */
  timezone?: string;
  accessRoles: string[];
}

export const SCOPE_READ = 'harvest:read';
export const SCOPE_WRITE = 'harvest:write';

/**
 * Per-request view of one connected Harvest account: the API client plus memoized lookups,
 * so several steps of one tool call share a single fetch of (say) project assignments.
 */
export class HarvestSession {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly client: HarvestClient,
    readonly props: HarvestProps,
    readonly canWrite: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get isAdmin(): boolean {
    return this.props.accessRoles.includes('administrator');
  }

  get isManager(): boolean {
    return this.isAdmin || this.props.accessRoles.includes('manager');
  }

  get roleLabel(): string {
    if (this.isAdmin) return 'Administrator';
    if (this.props.accessRoles.includes('manager')) return 'Manager';
    return 'Member';
  }

  requireWrite(): void {
    if (!this.canWrite) {
      throw new UserFacingError(
        'This connection is read-only. To log or change time, reconnect Harvest and tick "Log and edit time".',
      );
    }
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (!value) {
      value = load();
      this.memo.set(key, value);
      value.catch(() => this.memo.delete(key));
    }
    return value;
  }

  me(): Promise<HarvestUser> {
    return this.cached('me', () => this.client.get<HarvestUser>('/users/me'));
  }

  /** Company settings, or null when this person's role can't read them (non-admins). */
  company(): Promise<HarvestCompany | null> {
    return this.cached('company', async () => {
      try {
        return await this.client.get<HarvestCompany>('/company');
      } catch (error) {
        if (error instanceof HarvestApiError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    });
  }

  /** The person's active projects and tasks: everything they can log time to. */
  assignments(): Promise<ProjectAssignment[]> {
    return this.cached('assignments', async () => {
      const result = await this.client.list<ProjectAssignment>(
        '/users/me/project_assignments',
        'project_assignments',
        {},
        2000,
      );
      return result.items.filter((assignment) => assignment.is_active);
    });
  }

  async runningTimer(): Promise<TimeEntry | null> {
    const result = await this.client.list<TimeEntry>(
      '/time_entries',
      'time_entries',
      { is_running: true, user_id: this.props.userId },
      5,
    );
    return result.items[0] ?? null;
  }

  /** IANA zone for date math; falls back to UTC (and says so) when Harvest's name is unknown. */
  async timeZone(): Promise<{ zone: string; harvestName: string | null; known: boolean }> {
    let name = this.props.timezone ?? null;
    let zone = toIanaTimeZone(name);
    if (!zone) {
      name = (await this.me()).timezone ?? name;
      zone = toIanaTimeZone(name);
    }
    return zone ? { zone, harvestName: name, known: true } : { zone: 'UTC', harvestName: name, known: false };
  }

  async today(): Promise<string> {
    return todayIn((await this.timeZone()).zone, this.now());
  }

  async weekStart(): Promise<WeekStart> {
    const day = (await this.company())?.week_start_day;
    return day === 'Sunday' || day === 'Saturday' ? day : 'Monday';
  }

  currentTime(): Date {
    return this.now();
  }
}
