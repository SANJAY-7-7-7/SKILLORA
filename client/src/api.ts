export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
export type Skill = { _id: string; name: string; category: string; level: string; details?: string };
export type Person = { _id: string; name: string; email?: string; college?: string; department?: string; year?: string; bio?: string; avatarUrl?: string; rating?: number; completedExchanges?: number; teachSkills: Skill[]; learnSkills: Skill[]; availability?: string[]; coins?: number; badges?: string[] };
export type Match = Person & { score: number; teachesMe: string[]; ITeachThem: string[]; reasons: string[]; existingRequest?: string; existingStatus?: string };
export type RequestItem = { _id: string; sender: Person; recipient: Person; status: string; message?: string; offeredSkills: string[]; requestedSkills: string[]; createdAt: string };
export type SessionItem = { _id: string; exchange: string | { _id: string }; host: Person; guest: Person; title: string; skill: string; description?: string; startAt: string; endAt: string; meetingLink?: string; status: string; reviewedBy?: string[] };
export type NotificationItem = { _id: string; type: string; title: string; body: string; readAt?: string; createdAt: string; link?: string };

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers: { ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Something went wrong. Please try again.');
  return body as T;
}
export const json = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) });
export const patchJson = (data: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(data) });
