import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'pi-kanban',
  description: 'Workspace for the pi coding agent — sessions, todos, subagents, and more.',
  base: '/pi-kanban/docs/',
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: 'dark',
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'User Guide', link: '/user-guide' },
      { text: 'Theming', link: '/theming' },
      { text: 'Extensibility', link: '/extensibility' },
      { text: 'Demo', link: 'https://nikiforovall.github.io/pi-kanban/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'User Guide', link: '/user-guide' },
          { text: 'Theming', link: '/theming' },
          { text: 'Extensibility', link: '/extensibility' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NikiforovAll/pi-kanban' },
    ],
    editLink: {
      pattern: 'https://github.com/NikiforovAll/pi-kanban/edit/main/docs/:path',
    },
  },
});
