/** The subset of Harvest API v2 objects this connector reads. Field names match the API. */

export interface IdName {
  id: number;
  name: string;
}

export interface HarvestAccount {
  id: number;
  name: string;
  /** "harvest" or "forecast" */
  product: string;
}

export interface HarvestAccountsResponse {
  user?: { id: number; first_name?: string; last_name?: string; email?: string };
  accounts: HarvestAccount[];
}

export interface HarvestUser {
  id: number;
  first_name: string;
  last_name: string;
  email?: string;
  /** Rails-style zone name, e.g. "Eastern Time (US & Canada)". */
  timezone?: string;
  access_roles?: string[];
  is_contractor?: boolean;
  weekly_capacity?: number;
}

export interface HarvestCompany {
  name: string;
  base_uri?: string;
  full_domain?: string;
  week_start_day?: 'Saturday' | 'Sunday' | 'Monday' | string;
  wants_timestamp_timers?: boolean;
  time_format?: 'decimal' | 'hours_minutes' | string;
  clock?: '12h' | '24h' | string;
  currency_code_display?: string;
  plan_type?: string;
  invoice_feature?: boolean;
}

export interface TaskAssignment {
  id: number;
  is_active: boolean;
  billable?: boolean;
  task: IdName;
}

export interface ProjectAssignment {
  id: number;
  is_active: boolean;
  project: IdName & { code?: string | null };
  client: IdName;
  task_assignments: TaskAssignment[];
}

export interface HarvestClientRecord extends IdName {
  is_active: boolean;
  currency?: string;
}

export interface HarvestProject extends IdName {
  code?: string | null;
  is_active: boolean;
  is_billable?: boolean;
  client: IdName & { currency?: string };
}

export interface TimeEntry {
  id: number;
  spent_date: string;
  hours: number;
  rounded_hours?: number;
  notes: string | null;
  is_locked?: boolean;
  locked_reason?: string | null;
  is_running: boolean;
  is_billed: boolean;
  billable: boolean;
  approval_status?: string;
  timer_started_at?: string | null;
  started_time?: string | null;
  ended_time?: string | null;
  user: IdName;
  client: IdName;
  project: IdName;
  task: IdName;
  invoice?: { id: number; number: string } | null;
}

export interface TimeReportRow {
  client_id?: number;
  client_name?: string;
  project_id?: number;
  project_name?: string;
  task_id?: number;
  task_name?: string;
  user_id?: number;
  user_name?: string;
  is_contractor?: boolean;
  total_hours: number;
  billable_hours: number;
  currency?: string;
  billable_amount?: number;
}

export interface UninvoicedRow {
  client_id: number;
  client_name: string;
  project_id: number;
  project_name: string;
  currency: string;
  total_hours: number;
  uninvoiced_hours: number;
  uninvoiced_expenses: number;
  uninvoiced_amount: number;
}

export interface InvoiceLineItem {
  id: number;
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  project?: IdName | null;
}

export interface Invoice {
  id: number;
  client: IdName;
  number: string;
  state: 'draft' | 'open' | 'paid' | 'closed' | string;
  amount: number;
  due_amount: number;
  currency: string;
  issue_date: string | null;
  due_date: string | null;
  subject: string | null;
  period_start?: string | null;
  period_end?: string | null;
  sent_at?: string | null;
  paid_date?: string | null;
  line_items?: InvoiceLineItem[];
}
