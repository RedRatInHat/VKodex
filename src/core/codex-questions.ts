export interface CodexQuestion {
  readonly id: string;
  readonly title: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly secret: boolean;
}

export interface CodexQuestions {
  readonly key: string;
  readonly fingerprint: string;
  readonly kind: "blocking" | "async";
  readonly turnId: string;
  readonly requestId?: string | number;
  readonly questions: readonly CodexQuestion[];
}
