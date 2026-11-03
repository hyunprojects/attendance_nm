import { createClient } from '@supabase/supabase-js'

// HARDCODED FOR TESTING
const supabaseUrl = 'https://fuutweukcbfwpvlhsfja.supabase.co'
const supabaseKey = 'sb_publishable_zt-ffOTY3opBpI1OmxEF8A_rlZ8w3Qm'

export const supabase = createClient(supabaseUrl, supabaseKey)