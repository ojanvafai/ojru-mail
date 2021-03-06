interface Theme {
  name: string;
  styles: {
    '--border-and-hover-color': string;
    '--row-hover-color': string;
    '--nested-background-color': string;
    '--overlay-background-color': string;
    '--inverted-overlay-background-color': string;
    '--selected-background-color': string;
    '--text-color': string;
    '--dim-text-color': string;
    '--inverted-text-color': string;
    '--midpoint-color': string;
    '--main-background': string;
    '--button-group-1-bgcolor': string;
    '--button-group-2-bgcolor': string;
    '--button-group-3-bgcolor': string;
    '--button-group-4-bgcolor': string;
    '--button-group-5-bgcolor': string;
  };
}

export const DEFAULT: Theme = {
  name: 'Default',
  styles: {
    '--border-and-hover-color': '#00000047',
    '--row-hover-color': '#00000024',
    '--nested-background-color': '#ffffffbb',
    '--overlay-background-color': '#fff',
    '--inverted-overlay-background-color': '#000',
    '--selected-background-color': '#c2dbff',
    '--text-color': '#000',
    '--dim-text-color': '#666',
    '--inverted-text-color': '#fff',
    '--midpoint-color': '#aaa',
    '--main-background': '#f0f0ff',
    '--button-group-1-bgcolor': '#b3cce6',
    '--button-group-2-bgcolor': '#b3e5e6',
    '--button-group-3-bgcolor': '#b3e6bb',
    '--button-group-4-bgcolor': '#e1ebad',
    '--button-group-5-bgcolor': '#e6d5b3',
  },
};

export const DARK: Theme = {
  name: 'Dark',
  styles: {
    '--border-and-hover-color': '#666',
    '--row-hover-color': '#111',
    '--nested-background-color': '#000000bb',
    '--overlay-background-color': '#000',
    '--inverted-overlay-background-color': '#fff',
    '--selected-background-color': '#2F4F4F',
    '--text-color': '#fff',
    '--dim-text-color': '#bbb',
    '--inverted-text-color': '#000',
    '--midpoint-color': '#888',
    '--main-background': '#000',
    '--button-group-1-bgcolor': '#264b73',
    '--button-group-2-bgcolor': '#267073',
    '--button-group-3-bgcolor': '#267332',
    '--button-group-4-bgcolor': '#6b7c1d',
    '--button-group-5-bgcolor': '#736726',
  },
};

function randomColorNumber() {
  return Math.floor(Math.random() * 256);
}

function randomColor() {
  return `rgb(${randomColorNumber()},${randomColorNumber()},${randomColorNumber()}`;
}

export const RANDOM: Theme = {
  name: 'Random',
  styles: {
    '--border-and-hover-color': randomColor(),
    '--row-hover-color': randomColor(),
    '--nested-background-color': randomColor(),
    '--overlay-background-color': randomColor(),
    '--inverted-overlay-background-color': randomColor(),
    '--selected-background-color': randomColor(),
    '--text-color': randomColor(),
    '--dim-text-color': randomColor(),
    '--inverted-text-color': randomColor(),
    '--midpoint-color': randomColor(),
    '--main-background': randomColor(),
    '--button-group-1-bgcolor': randomColor(),
    '--button-group-2-bgcolor': randomColor(),
    '--button-group-3-bgcolor': randomColor(),
    '--button-group-4-bgcolor': randomColor(),
    '--button-group-5-bgcolor': randomColor(),
  },
};

export const THEMES = [DEFAULT, DARK, RANDOM];
const MAIN_BACKGROUND_PROPERTY = '--main-background';
const DARK_MODE_CLASSNAME = 'dark-mode';

export class Themes {
  static toggleDarkMode() {
    // Put dark mode in storage separate from the theme so that toggling dark
    // mode doesn't lose the chosen theme.
    localStorage.darkMode = !this.isDarkMode();
    this.apply();
  }

  static isDarkMode() {
    return localStorage.darkMode === 'true';
  }

  static setTheme(themeName: string) {
    let theme = THEMES.find((x) => x.name === themeName) || DEFAULT;
    // Cache the full theme in localStorage so it's available immediately before
    // the settings have loaded off the netowrk.
    localStorage.theme = JSON.stringify(theme);
    this.apply();
  }

  static apply() {
    let isDarkMode = this.isDarkMode();

    let theme;
    // Dark mode wins over all other theming.
    if (isDarkMode) {
      document.documentElement.classList.add(DARK_MODE_CLASSNAME);

      theme = DARK;
    } else {
      document.documentElement.classList.remove(DARK_MODE_CLASSNAME);

      if (localStorage.theme) theme = JSON.parse(localStorage.theme) as Theme;
      else theme = DEFAULT;
    }

    // Cache in localstorage so we can set this in index.html without flash of
    // white on reload.
    localStorage.background = theme.styles[MAIN_BACKGROUND_PROPERTY];

    let root = document.documentElement;

    root.style.setProperty('--max-width', '1000px');
    root.style.setProperty('--thread-text-color', isDarkMode ? '#fff' : '#000');
    root.style.setProperty('--thread-background-color', isDarkMode ? '#000' : '#fff');

    for (let style of Object.entries(theme.styles)) {
      root.style.setProperty(style[0], style[1]);
    }
  }
}
