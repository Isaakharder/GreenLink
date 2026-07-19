// Hand-written types mirroring the Supabase migrations in supabase/migrations/.
// There is no live Supabase project to generate these from yet; keep this file
// in sync with the SQL by hand until `supabase gen types` becomes available.

export type TournamentStatus = 'draft' | 'upcoming' | 'live' | 'completed' | 'cancelled';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type MembershipStatus = 'accepted' | 'removed';
export type DistanceUnit = 'yards' | 'metres';
export type PersonalRoundVisibility = 'private' | 'public';
export type WalkingOrCart = 'walking' | 'cart';

export interface Profile {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  photo_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Tournament {
  id: string;
  organizer_user_id: string;
  name: string;
  course_name: string;
  tournament_date: string;
  hole_count: number;
  scoring_format: string | null;
  team_size: number | null;
  description: string | null;
  status: TournamentStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  golf_course_id: string | null;
  golf_course_tee_id: string | null;
  course_rating: number | null;
  slope_rating: number | null;
  data_version: number;
  is_personal: boolean;
}

// My Golf (Phase 1): a personal round is a one-player tournament
// (tournaments.is_personal = true) with this 1:1 extension row for the
// fields a tournament has no concept of. See supabase/migrations/0024.
export interface PersonalRound {
  tournament_id: string;
  visibility: PersonalRoundVisibility;
  walking_or_cart: WalkingOrCart;
  created_at: string;
}

// get_public_round_feed() return shape (Home page Community Feed).
export interface PublicRoundFeedItem {
  tournament_id: string;
  player_first_name: string;
  player_last_name: string;
  course_name: string;
  tee_name: string | null;
  tournament_date: string;
  completed_at: string;
  hole_count: number;
  total_strokes: number;
  relative_to_par: number;
}

// get_my_golf_stats() return shape.
export interface MyGolfBestRound {
  tournament_id: string;
  course_name: string;
  tournament_date: string;
  relative_to_par: number;
}

export interface MyGolfStats {
  rounds_played: number;
  average_score: number | null;
  best_round: MyGolfBestRound | null;
  birdies: number;
  pars: number;
  bogeys: number;
  double_bogeys_plus: number;
  courses_played: number;
}

// Rows cached from GolfCourseAPI (see supabase/functions/golf-course-lookup)
// -- shared, non-tournament-scoped reference data. Never written to
// directly by the frontend; only read.
export interface GolfCourse {
  id: string;
  external_id: string;
  club_name: string;
  course_name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  imported_by: string;
  imported_at: string;
  raw_payload: unknown;
}

export type GolfCourseTeeGender = 'male' | 'female';

export interface GolfCourseTee {
  id: string;
  golf_course_id: string;
  tee_name: string;
  gender: GolfCourseTeeGender;
  number_of_holes: number;
  par_total: number | null;
  course_rating: number | null;
  slope_rating: number | null;
}

export interface GolfCourseTeeHole {
  id: string;
  tee_id: string;
  hole_number: number;
  par: number;
  yardage: number | null;
  handicap: number | null;
}

export interface TournamentInvitation {
  id: string;
  tournament_id: string;
  invited_user_id: string;
  invited_by_user_id: string;
  status: InvitationStatus;
  responded_at: string | null;
  created_at: string;
}

export interface TournamentTeam {
  id: string;
  tournament_id: string;
  name: string | null;
  team_number: number | null;
  created_at: string;
}

export interface TournamentPlayer {
  id: string;
  tournament_id: string;
  user_id: string;
  team_id: string | null;
  membership_status: MembershipStatus;
  is_organizer: boolean;
  joined_at: string;
}

export interface TournamentHole {
  id: string;
  tournament_id: string;
  hole_number: number;
  par: number;
  stroke_index: number | null;
  distance: number | null;
  distance_unit: DistanceUnit;
}

export interface TeamHoleScore {
  id: string;
  tournament_id: string;
  team_id: string;
  hole_number: number;
  strokes: number;
  revision: number;
  last_updated_by: string | null;
  updated_at: string;
  created_at: string;
}

export interface ScoreOperation {
  id: string;
  operation_uuid: string;
  tournament_id: string;
  team_id: string;
  hole_number: number;
  previous_strokes: number | null;
  new_strokes: number;
  revision: number;
  changed_by: string;
  device_timestamp: string | null;
  server_timestamp: string;
  change_reason: string | null;
  expected_revision: number | null;
}

// submit_team_score() returns this discriminated union instead of a raw row:
// a revision conflict is an expected outcome the client must present to the
// user, not an exception.
export interface SubmitScoreOk {
  status: 'ok';
  score: TeamHoleScore;
}

export interface SubmitScoreConflict {
  status: 'conflict';
  server: {
    strokes: number;
    revision: number;
    updated_by_user_id: string | null;
    updated_by_name: string | null;
    updated_at: string;
  };
  submitted: {
    strokes: number;
  };
}

export type SubmitScoreResult = SubmitScoreOk | SubmitScoreConflict;

export type LifecycleEventType = 'finished' | 'force_finished';

export interface TournamentLifecycleEvent {
  id: string;
  tournament_id: string;
  event_type: LifecycleEventType;
  performed_by: string;
  reason: string | null;
  created_at: string;
}

export interface TeamProgress {
  team_id: string;
  name: string;
  holes_scored: number;
  holes_remaining: number;
  percent_complete: number;
  complete: boolean;
}

export interface TournamentProgress {
  hole_count: number;
  teams: TeamProgress[];
  teams_finished: number;
  teams_playing: number;
  total_synced_entries: number;
  all_complete: boolean;
}

// Live tournament chat (supabase/migrations/0025). One shared channel per
// tournament in Phase 1 -- sender_team_id is snapshotted at send time
// (team assignment is frozen once a tournament is live) rather than joined
// live, and is unused for filtering until a future team-only channel.
export interface TournamentMessage {
  id: string;
  operation_uuid: string;
  tournament_id: string;
  sender_user_id: string;
  sender_team_id: string | null;
  message_text: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface TournamentChatRead {
  tournament_id: string;
  user_id: string;
  last_read_at: string;
}

// get_tournament_chat_summary() return shape.
export interface TournamentChatSummary {
  unread_count: number;
  last_read_at: string | null;
}

// get_my_tournament_unread_counts() return shape (one row per live tournament).
export interface TournamentUnreadCount {
  tournament_id: string;
  unread_count: number;
}
