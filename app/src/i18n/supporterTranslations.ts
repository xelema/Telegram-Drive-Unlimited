import i18n from './index';
import supporterTranslations from './locales/en.json?supporter';

// Keep optional license copy out of startup JavaScript while registering it
// synchronously before either the offer or purchase UI renders.
i18n.addResourceBundle('en', 'translation', supporterTranslations, true, true);
