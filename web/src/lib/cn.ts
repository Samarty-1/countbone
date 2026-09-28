/** Join class names, dropping falsy ones. Small enough not to need clsx. */
export const cn = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");
