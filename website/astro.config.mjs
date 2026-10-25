// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://nikiforovall.blog',
	base: '/pi-kanban',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'pi-kanban',
			description: 'An agent development environment for the pi coding agent: sessions, terminal, todos, and subagents in one board.',
			favicon: '/favicon.svg',
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://nikiforovall.blog/pi-kanban/og.png' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://nikiforovall.blog/pi-kanban/og.png' } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/NikiforovAll/pi-kanban' }],
			editLink: { baseUrl: 'https://github.com/NikiforovAll/pi-kanban/edit/main/website/' },
			customCss: ['./src/kit/kit.css'],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{ label: 'Start here', items: [{ label: 'Getting started', slug: 'getting-started' }] },
				{
					label: 'Guides',
					items: [
						{ label: 'User guide', slug: 'guides/user-guide' },
						{ label: 'Terminal and sessions', slug: 'guides/terminal-and-sessions' },
						{ label: 'Show and ask', slug: 'guides/show-and-ask' },
						{ label: 'Review', slug: 'guides/review' },
						{ label: 'Panes and docs', slug: 'guides/panes-and-docs' },
						{ label: 'Dispatch', slug: 'guides/dispatch' },
						{ label: 'Navigation and zen', slug: 'guides/navigation' },
						{ label: 'Companions', slug: 'guides/companions' },
						{ label: 'Extensibility', slug: 'guides/extensibility' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Command line', slug: 'reference/cli' },
						{ label: 'Keyboard shortcuts', slug: 'reference/shortcuts' },
						{ label: 'Theming', slug: 'reference/theming' },
					],
				},
			],
		}),
	],
});
