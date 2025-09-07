/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        tg: {
          bg: "#0E1621",
          header: "#17212B",
          bubbleOut: "#2B5278",
          bubbleIn: "#182533",
          text: "#EAF2F7",
          sub: "#8CA0B3",
          accent: "#5EB5F7"
        }
      },
      boxShadow: {
        soft: "0 8px 28px rgba(0,0,0,.24)"
      }
    }
  },
  plugins: [],
}
