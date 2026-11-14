import type { Language } from './index';

export const xoRules: Record<Language, string> = {
  en: 'Take turns placing X or O. The first player to make a line of three wins. A full board with no line is a draw.',
  am: 'በተራ በሰሌዳው ላይ X ወይም O ያስቀምጡ። ሶስት ምልክቶችን በአንድ መስመር ያስቀመጠ ተጫዋች ያሸንፋል። ሰሌዳው ሞልቶ መስመር ካልተሰራ አቻ ነው።',
  so: 'Isku beddela inaad dhigtaan X ama O. Ciyaaryahanka ugu horreeya ee saddex calaamadood isku xariiqiya ayaa guulaysanaya. Loox buuxa oo aan xariiq lahayn waa barbaro.',
  om: 'Tartiibaan X yookaan O kaa’ii. Taphataan mallattoo sadii sarara tokko irra kaa’e injifata. Gabateen guutuu ta’ee sararri yoo hin uumamne walqixa.',
};
