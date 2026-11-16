export interface BundledExample {
  id: 'scene' | 'text' | 'ambiguous';
  label: string;
  shortDescription: string;
  assetPath: string;
  altText: string;
  presetQuestion: string;
  evaluationFocus: string;
}

export const BUNDLED_EXAMPLES: readonly BundledExample[] = [
  {
    id: 'scene',
    label: 'Few objects in a clear scene',
    shortDescription:
      'Wooden desk with laptop, articulated lamp, book stacks, notebook, glasses, and file holder.',
    assetPath: `${import.meta.env.BASE_URL}examples/scene-objects.jpg`,
    altText:
      'A wooden desk with a black desk lamp and open silver laptop on the left, stacks of books and magazines on the right, an open spiral notebook with eyeglasses in the foreground, and a white file holder at the far right.',
    presetQuestion: 'What objects are visible and where are they?',
    evaluationFocus: 'Object identification and spatial relations',
  },
  {
    id: 'text',
    label: 'Clearly legible short text',
    shortDescription:
      'Yellow plastic electric fence warning sign clipped to wire fencing beside a wooden post.',
    assetPath: `${import.meta.env.BASE_URL}examples/short-text.jpg`,
    altText:
      'A yellow warning sign mounted on a wire fence next to a wooden post reading ELECTRIC FENCE above a hand and lightning symbol, with smaller manufacturer text along the bottom.',
    presetQuestion: 'Transcribe the visible text.',
    evaluationFocus: 'Exact text, omissions and invented characters',
  },
  {
    id: 'ambiguous',
    label: 'Partly obscured or ambiguous object',
    shortDescription:
      'Car parked under an opaque black fitted cover in underground garage bay 1308.',
    assetPath: `${import.meta.env.BASE_URL}examples/ambiguous-object.jpg`,
    altText:
      'An underground parking garage showing a vehicle draped in a dark fitted cover in bay 1308 with a wheel peeking out underneath, flanked by two uncovered dark cars.',
    presetQuestion:
      'Can you identify the partly hidden object? Explain any uncertainty.',
    evaluationFocus: 'Unsupported specificity and recognition of ambiguity',
  },
];
