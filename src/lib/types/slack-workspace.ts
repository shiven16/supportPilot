import { SupportPilotUserAccessLevel } from '../constants';

//  Type definition for access settings
export type AccessSettingsType = {
  allowedUsersForDmInteraction: SupportPilotUserAccessLevel;
  allowedChannelIds?: string[];
};
