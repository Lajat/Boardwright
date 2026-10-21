/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // A single indigo/violet brand scale used for primary actions,
        // links, and accents throughout the app — keeps the palette
        // consistent instead of mixing ad-hoc blue/gray/indigo per page.
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
        },
        // The second color in the logo's gradient (brand-500 -> violet-600)
        // — a real theme token now, not a one-off hex baked into a single
        // SVG the way it was before. Used on primary actions (the
        // "brand moments": log in, sign up, invite, create) so those match
        // the logo instead of the logo being the one inconsistent thing.
        violet: {
          600: "#7c3aed",
        },
      },
    },
  },
  plugins: [],
};
