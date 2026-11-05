import { z } from 'zod';

const shortText = z.string().max(300);
export const learnedLocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('role'),
    role: z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio']),
    name: shortText.min(1),
  }),
  z.strictObject({ kind: z.literal('label'), value: shortText.min(1) }),
  z.strictObject({ kind: z.literal('text'), value: shortText.min(1) }),
  z.strictObject({ kind: z.literal('testId'), value: shortText.min(1) }),
  z.strictObject({
    kind: z.literal('css'),
    value: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !/[\r\n]|>>|:has\(|:has-text\(|:text\(/i.test(value)),
  }),
  z.strictObject({
    kind: z.literal('xpath'),
    value: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\/\/(?:[a-z]+|\*)(?:\[@[a-z-]+=(?:"[^"\r\n]*"|'[^'\r\n]*')\])?$/),
  }),
]);
export type LearnedLocator = z.infer<typeof learnedLocatorSchema>;
export const elementFingerprintSchema = z.strictObject({
  role: z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio']),
  name: shortText,
  text: shortText,
  locators: z.array(learnedLocatorSchema).min(1).max(6),
  box: z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
    })
    .nullable(),
  crop: z.literal('withheld'),
});
export type ElementFingerprint = z.infer<typeof elementFingerprintSchema>;
