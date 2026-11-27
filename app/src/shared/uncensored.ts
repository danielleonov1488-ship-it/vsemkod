const pattern = /uncensor|abliterat|dealign|heretic|unfilter|unalign|no-?refusal|без цензуры/i;

export function isUncensored(...values: (string | undefined)[]) {
  return values.some(value => !!value && pattern.test(value));
}
