BEGIN {
  expected_subject = kind "=" subject
}

index($0, "[Spott OTP]") == 0 {
  next
}

{
  subject_matches = 0
  candidate = ""

  for (field_index = 1; field_index <= NF; field_index += 1) {
    if ($field_index == expected_subject) {
      subject_matches = 1
    }
    if (substr($field_index, 1, 5) == "code=") {
      value = substr($field_index, 6)
      if (length(value) == 6 && value !~ /[^0-9]/) {
        candidate = value
      }
    }
  }

  if (subject_matches && candidate != "") {
    latest = candidate
  }
}

END {
  if (latest != "") {
    print latest
  }
}
