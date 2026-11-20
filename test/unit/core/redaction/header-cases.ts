type HeaderCase = [label: string, name: string, value: string, expected: string];
type ValueCase = [label: string, value: string, expected: string];

export const headerCases = (name: string, cases: ValueCase[]): HeaderCase[] =>
  cases.map(([label, value, expected]) => [label, name, value, expected]);
