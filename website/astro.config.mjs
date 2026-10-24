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
			description: 'A live board for every pi coding agent session on your machine.',
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
						{ label: 'Extensibility', slug: 'guides/extensibility' },
					],
				},
				{
					label: 'Reference',
					items: [{ label: 'Theming', slug: 'reference/theming' }],
				},
			],
		}),
	],
});
