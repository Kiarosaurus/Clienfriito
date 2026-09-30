// Shared Tailwind modifiers that strip native number-input spinners across
// Firefox ([appearance:textfield]) and WebKit (the two pseudo-elements).
// Concatenate onto a view's own base input class string.
export const NUM_INPUT_MODS =
  '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
