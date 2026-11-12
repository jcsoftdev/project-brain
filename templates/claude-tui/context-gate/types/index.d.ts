export type GateConfig = {
  enabled: boolean
  allow: string[]
}

export type Piece = { text: string; allowed: boolean }

export type Framed = { frame: string; pieces: Piece[] }

export type Sent = true | { text: string | null }

export type SessionRecord = {
  epoch: number
  touched: number
  sent: Record<string, Sent>
}

export type Verdict = { keep: boolean[]; scores: Array<number | null> }

export type DroppedEntry = {
  at: number
  session: string
  type: string
  event: string
  chars: number
  score: number | null
  head: string
}
